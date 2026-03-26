import * as tl from 'azure-pipelines-task-lib/task';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as os from 'os';

/**
 * Check if PowerShell 7 (pwsh) is available on the system
 */
function checkPwshAvailable(): boolean {
    try {
        const result = child_process.spawnSync('pwsh', ['--version'], {
            encoding: 'utf8',
            shell: true
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

/**
 * Check if we're running on Windows
 */
function isWindows(): boolean {
    return process.platform === 'win32';
}

async function run(): Promise<void> {
    try {
        // Check prerequisites first
        console.log('Checking prerequisites...');
        
        // Check if PowerShell 7 (pwsh) is available
        if (!checkPwshAvailable()) {
            tl.setResult(tl.TaskResult.Failed, 
                'PowerShell 7 (pwsh) is required but not found. ' +
                'Please install PowerShell 7 or later. ' +
                'Visit https://docs.microsoft.com/en-us/powershell/scripting/install/installing-powershell for installation instructions.');
            return;
        }
        console.log('PowerShell 7 (pwsh) is available.');

        // Check author filter first (before any other processing)
        const authors = tl.getInput('authors');
        if (authors) {
            const requestedForEmail = tl.getVariable('Build.RequestedForEmail') || '';
            const authorList = authors.split(',').map(email => email.trim().toLowerCase());
            const currentAuthor = requestedForEmail.toLowerCase();
            
            console.log('='.repeat(60));
            console.log('Author Filter Check');
            console.log('='.repeat(60));
            console.log(`Configured authors: ${authorList.join(', ')}`);
            console.log(`PR author email: ${requestedForEmail || '(not available)'}`);
            
            if (!authorList.includes(currentAuthor)) {
                console.log(`Result: PR author is NOT in the configured authors list.`);
                console.log('Skipping code review for this PR.');
                console.log('='.repeat(60));
                tl.setResult(tl.TaskResult.Succeeded, 'Skipped: PR author not in configured authors list.');
                return;
            }
            
            console.log(`Result: PR author IS in the configured authors list.`);
            console.log('Proceeding with code review.');
            console.log('='.repeat(60));
        }

        // Get required inputs
        const githubPat = tl.getInputRequired('githubPat');
        
        // Get Azure DevOps authentication settings
        const useSystemAccessToken = tl.getBoolInput('useSystemAccessToken', false);
        const azureDevOpsPat = tl.getInput('azureDevOpsPat');
        
        // Determine which token and auth type to use
        let azureDevOpsToken: string;
        let azureDevOpsAuthType: string;
        
        if (useSystemAccessToken) {
            // Use System.AccessToken (OAuth Bearer token)
            const systemToken = tl.getVariable('System.AccessToken');
            if (!systemToken) {
                tl.setResult(tl.TaskResult.Failed, 
                    'System.AccessToken is not available. Ensure the pipeline has access to the OAuth token. ' +
                    'In YAML pipelines, you may need to explicitly map it using env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)');
                return;
            }
            azureDevOpsToken = systemToken;
            azureDevOpsAuthType = 'Bearer';
            console.log('Using System.AccessToken (OAuth) for Azure DevOps authentication.');
        } else if (azureDevOpsPat) {
            // Use provided PAT (Basic auth)
            azureDevOpsToken = azureDevOpsPat;
            azureDevOpsAuthType = 'Basic';
            console.log('Using Personal Access Token for Azure DevOps authentication.');
        } else {
            tl.setResult(tl.TaskResult.Failed, 
                'Azure DevOps authentication is required. Either provide an Azure DevOps PAT or enable "Use System Access Token".');
            return;
        }
        
        // Get inputs with defaults from pipeline variables
        let organization = tl.getInput('organization');
        let collectionUri = tl.getInput('collectionUri');
        let project = tl.getInput('project');
        let repository = tl.getInput('repository');

        // Resolve the collection URI using priority chain:
        // 1. Explicit collectionUri input
        // 2. organization input -> construct https://dev.azure.com/{org}
        // 3. System.CollectionUri pipeline variable (used directly)
        let resolvedCollectionUri: string | undefined;

        if (collectionUri) {
            resolvedCollectionUri = collectionUri.replace(/\/+$/, '');
            console.log(`Using explicit collection URI: ${resolvedCollectionUri}`);
        } else if (organization) {
            resolvedCollectionUri = `https://dev.azure.com/${organization}`;
            console.log(`Constructed collection URI from organization: ${resolvedCollectionUri}`);
        } else {
            const systemCollectionUri = tl.getVariable('System.CollectionUri');
            if (systemCollectionUri) {
                resolvedCollectionUri = systemCollectionUri.replace(/\/+$/, '');
                console.log(`Auto-detected collection URI from System.CollectionUri: ${resolvedCollectionUri}`);
            }
        }

        if (!resolvedCollectionUri) {
            tl.setResult(tl.TaskResult.Failed,
                'Collection URI could not be determined. Provide collectionUri, organization, or ensure System.CollectionUri is available.');
            return;
        }

        if (!project) {
            tl.setResult(tl.TaskResult.Failed, 'Project is required. Either provide it as an input or ensure System.TeamProject is available.');
            return;
        }

        if (!repository) {
            tl.setResult(tl.TaskResult.Failed, 'Repository is required. Either provide it as an input or ensure Build.Repository.Name is available.');
            return;
        }

        // Get optional inputs
        let pullRequestId = tl.getInput('pullRequestId');
        const timeoutMinutes = parseInt(tl.getInput('timeout') || '15', 10);
        const model = tl.getInput('model');
        const promptFile = tl.getInput('promptFile');
        const prompt = tl.getInput('prompt');
        const promptRaw = tl.getInput('promptRaw');
        const promptFileRaw = tl.getInput('promptFileRaw');
        const includeWorkItems = tl.getBoolInput('includeWorkItems', false);

        // If PR ID not provided, try to get from pipeline variable
        if (!pullRequestId) {
            pullRequestId = tl.getVariable('System.PullRequest.PullRequestId');
        }

        if (!pullRequestId) {
            tl.setResult(tl.TaskResult.Failed, 'Pull Request ID is required. Either provide it as an input or run this task as part of a PR validation build.');
            return;
        }

        console.log('='.repeat(60));
        console.log('Copilot Code Review Task');
        console.log('='.repeat(60));
        console.log(`Collection URI: ${resolvedCollectionUri}`);
        console.log(`Project: ${project}`);
        console.log(`Repository: ${repository}`);
        console.log(`Pull Request ID: ${pullRequestId}`);
        console.log(`Timeout: ${timeoutMinutes} minutes`);
        if (model) {
            console.log(`Model: ${model}`);
        }
        console.log('='.repeat(60));

        // Set environment variables for PowerShell scripts
        process.env['GH_TOKEN'] = githubPat;
        process.env['AZUREDEVOPS_TOKEN'] = azureDevOpsToken;
        process.env['AZUREDEVOPS_AUTH_TYPE'] = azureDevOpsAuthType;
        process.env['AZUREDEVOPS_COLLECTION_URI'] = resolvedCollectionUri;
        process.env['PROJECT'] = project;
        process.env['REPOSITORY'] = repository;
        process.env['PRID'] = pullRequestId;

        const scriptsDir = path.join(__dirname, 'scripts');
        const workingDirectory = tl.getVariable('System.DefaultWorkingDirectory') || process.cwd();

        // Step 1: Install GitHub Copilot CLI if not present
        console.log('\n[Step 1/5] Checking GitHub Copilot CLI installation...');
        const copilotInstalled = await checkCopilotCli();
        if (!copilotInstalled) {
            console.log('GitHub Copilot CLI not found. Installing...');
            await installCopilotCli();
        } else {
            console.log('GitHub Copilot CLI is already installed.');
        }

        // Step 2: Fetch PR details
        console.log('\n[Step 2/5] Fetching pull request details...');
        const prDetailsScript = path.join(scriptsDir, 'Get-AzureDevOpsPR.ps1');
        const prDetailsOutput = path.join(workingDirectory, 'PR_Details.txt');
        
        await runPowerShellScript(prDetailsScript, [
            `-Token "${azureDevOpsToken}"`,
            `-AuthType "${azureDevOpsAuthType}"`,
            `-CollectionUri "${resolvedCollectionUri}"`,
            `-Project "${project}"`,
            `-Repository "${repository}"`,
            `-Id ${pullRequestId}`,
            `-OutputFile "${prDetailsOutput}"`
        ]);
        console.log(`PR details saved to: ${prDetailsOutput}`);

        // Step 3: Fetch PR changes (iteration details)
        console.log('\n[Step 3/5] Fetching pull request changes...');
        const prChangesScript = path.join(scriptsDir, 'Get-AzureDevOpsPRChanges.ps1');
        const iterationDetailsOutput = path.join(workingDirectory, 'Iteration_Details.txt');
        
        await runPowerShellScript(prChangesScript, [
            `-Token "${azureDevOpsToken}"`,
            `-AuthType "${azureDevOpsAuthType}"`,
            `-CollectionUri "${resolvedCollectionUri}"`,
            `-Project "${project}"`,
            `-Repository "${repository}"`,
            `-Id ${pullRequestId}`,
            `-OutputFile "${iterationDetailsOutput}"`
        ]);
        console.log(`Iteration details saved to: ${iterationDetailsOutput}`);

        // Read the iteration ID from the file written by Get-AzureDevOpsPRChanges.ps1
        const iterationIdFile = path.join(workingDirectory, 'Iteration_Id.txt');
        if (fs.existsSync(iterationIdFile)) {
            const iterationId = fs.readFileSync(iterationIdFile, 'utf8').trim();
            if (iterationId) {
                process.env['ITERATION_ID'] = iterationId;
                console.log(`Iteration ID set to: ${iterationId}`);
            }
        }

        // Step 4: Fetch linked work item details (optional)
        if (includeWorkItems) {
            console.log('\n[Step 4/5] Fetching linked work item details...');
            const workItemIdsFile = path.join(workingDirectory, 'Work_Item_Ids.txt');

            if (fs.existsSync(workItemIdsFile)) {
                const workItemIds = fs.readFileSync(workItemIdsFile, 'utf8').trim();

                if (workItemIds) {
                    const workItemsScript = path.join(scriptsDir, 'Get-AzureDevOpsWorkItems.ps1');
                    const workItemDetailsOutput = path.join(workingDirectory, 'Work_Item_Details.txt');

                    try {
                        await runPowerShellScript(workItemsScript, [
                            `-Token "${azureDevOpsToken}"`,
                            `-AuthType "${azureDevOpsAuthType}"`,
                            `-CollectionUri "${resolvedCollectionUri}"`,
                            `-Project "${project}"`,
                            `-WorkItemIds "${workItemIds}"`,
                            `-OutputFile "${workItemDetailsOutput}"`
                        ]);
                        console.log(`Work item details saved to: ${workItemDetailsOutput}`);
                    } catch (err) {
                        console.log('Warning: Failed to fetch work item details. Continuing without work item context.');
                        console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
                    }
                } else {
                    console.log('No linked work item IDs found. Skipping work item detail fetch.');
                }
            } else {
                console.log('No linked work items for this PR. Skipping work item detail fetch.');
            }
        } else {
            console.log('\n[Step 4/5] Skipping work item details (disabled).');
        }

        // Step 5: Run Copilot CLI for code review
        console.log('\n[Step 5/5] Running Copilot code review...');
        
        // Determine the prompt file to use
        let promptFilePath: string = '';
        let customPromptText: string | null = null;

        // Helper to check if filePath inputs are actually set (filePath inputs return working dir when empty)
        const isPromptFileSet = promptFile &&
            fs.existsSync(promptFile) &&
            fs.statSync(promptFile).isFile();
        const isPromptFileRawSet = promptFileRaw &&
            fs.existsSync(promptFileRaw) &&
            fs.statSync(promptFileRaw).isFile();

        // Validate that only one prompt input is provided
        const activePromptInputs: string[] = [];
        if (prompt) activePromptInputs.push('prompt');
        if (isPromptFileSet) activePromptInputs.push('promptFile');
        if (promptRaw) activePromptInputs.push('promptRaw');
        if (isPromptFileRawSet) activePromptInputs.push('promptFileRaw');

        if (activePromptInputs.length > 1) {
            tl.setResult(tl.TaskResult.Failed,
                `Multiple prompt inputs are set (${activePromptInputs.join(', ')}). Only one prompt input should be provided. ` +
                'Please use only one of: prompt, promptFile, promptRaw, or promptFileRaw.');
            return;
        }

        if (promptRaw) {
            // Raw prompt: pass directly to CLI with no modification
            console.log('Using raw prompt from input.');
            promptFilePath = path.join(workingDirectory, '_copilot_prompt.txt');
            fs.writeFileSync(promptFilePath, promptRaw, 'utf8');
            console.log('\nRAW PROMPT:\n' + promptRaw + '\n\n');
        } else if (isPromptFileRawSet) {
            // Raw prompt file: use file contents as-is with no modification
            console.log(`Using raw prompt from file: ${promptFileRaw}`);
            const fileContent = fs.readFileSync(promptFileRaw!, 'utf8');
            if (!fileContent.trim()) {
                tl.setResult(tl.TaskResult.Failed, `Raw prompt file is empty: ${promptFileRaw}`);
                return;
            }
            promptFilePath = path.join(workingDirectory, '_copilot_prompt.txt');
            fs.writeFileSync(promptFilePath, fileContent, 'utf8');
            console.log('\nRAW PROMPT:\n' + fileContent + '\n\n');
        } else if (prompt) {
            // Direct prompt input: merge with template
            console.log('Using custom prompt from input.');
            if (prompt.includes('"')) {
                tl.setResult(tl.TaskResult.Failed, 'Custom prompts cannot include double quotes ("). Please remove any double quotes from your prompt input.');
                return;
            }
            customPromptText = prompt;
        } else if (isPromptFileSet) {
            // Read from prompt file: merge with template
            console.log(`Using custom prompt from file: ${promptFile}`);
            const fileContent = fs.readFileSync(promptFile!, 'utf8').trim();
            if (!fileContent) {
                tl.setResult(tl.TaskResult.Failed, `Prompt file is empty: ${promptFile}`);
                return;
            }
            if (fileContent.includes('"')) {
                tl.setResult(tl.TaskResult.Failed, `Custom prompts cannot include double quotes ("). Please remove any double quotes from the prompt file: ${promptFile}`);
                return;
            }
            customPromptText = fileContent;
        }

        if (customPromptText) {
            // Use custom prompt template with placeholder replacement
            const customPromptTemplate = path.join(scriptsDir, 'prompt-custom.txt');
            const templateContent = fs.readFileSync(customPromptTemplate, 'utf8');
            const mergedPrompt = templateContent.replace('%CUSTOMPROMPT%', customPromptText);
            console.log('\nCUSTOM PROMPT:\n' + mergedPrompt + '\n\n');

            // Write merged prompt to a temp file in the working directory
            promptFilePath = path.join(workingDirectory, '_copilot_prompt.txt');
            fs.writeFileSync(promptFilePath, mergedPrompt, 'utf8');
            console.log('Custom prompt merged with instruction template.');
        } else if (!promptRaw && !isPromptFileRawSet) {
            // Use default prompt file bundled with the task
            promptFilePath = path.join(scriptsDir, 'prompt.txt');
            console.log('Using default prompt.');
        }

        // Copy the Add-AzureDevOpsPRComment.ps1 and Add-AzureDevOpsPRComment.ps1 script to the working directory
        // so Copilot can find and use them for posting PR comments
        const addCommentScriptSource = path.join(scriptsDir, 'Add-AzureDevOpsPRComment.ps1');
        const commentScriptSource = path.join(scriptsDir, 'Add-CopilotComment.ps1');
        const updateCommentScriptSource = path.join(scriptsDir, 'Update-CopilotComment.ps1');
        const deleteCommentScriptSource = path.join(scriptsDir, 'Delete-CopilotComment.ps1');
        const addCommentScriptDest = path.join(workingDirectory, 'Add-AzureDevOpsPRComment.ps1');
        const commentScriptDest = path.join(workingDirectory, 'Add-CopilotComment.ps1');
        const updateCommentScriptDest = path.join(workingDirectory, 'Update-CopilotComment.ps1');
        const deleteCommentScriptDest = path.join(workingDirectory, 'Delete-CopilotComment.ps1');
        fs.copyFileSync(addCommentScriptSource, addCommentScriptDest);
        console.log(`Copied Add-AzureDevOpsPRComment.ps1 to: ${addCommentScriptDest}`);
        fs.copyFileSync(commentScriptSource, commentScriptDest);
        console.log(`Copied Add-CopilotComment.ps1 to: ${commentScriptDest}`);
        fs.copyFileSync(updateCommentScriptSource, updateCommentScriptDest);
        console.log(`Copied Update-CopilotComment.ps1 to: ${updateCommentScriptDest}`);
        fs.copyFileSync(deleteCommentScriptSource, deleteCommentScriptDest);
        console.log(`Copied Delete-CopilotComment.ps1 to: ${deleteCommentScriptDest}`);
        
        // Run Copilot CLI with timeout
        const timeoutMs = timeoutMinutes * 60 * 1000;
        await runCopilotCli(promptFilePath, model, workingDirectory, timeoutMs);

        console.log('\n' + '='.repeat(60));
        console.log('Copilot Code Review completed successfully!');
        console.log('='.repeat(60));

        tl.setResult(tl.TaskResult.Succeeded, 'Copilot code review completed.');
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        tl.setResult(tl.TaskResult.Failed, `Task failed: ${errorMessage}`);
    }
}

async function checkCopilotCli(): Promise<boolean> {
    try {
        const result = child_process.spawnSync('copilot', ['--version'], {
            encoding: 'utf8',
            shell: true
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

async function installCopilotCli(): Promise<void> {
    return new Promise((resolve, reject) => {
        let command: string;
        let args: string[];

        if (isWindows()) {
            console.log('Installing GitHub Copilot CLI via winget...');
            command = 'winget';
            args = ['install', 'GitHub.Copilot', '--silent', '--accept-package-agreements', '--accept-source-agreements'];
        } else {
            console.log('Installing GitHub Copilot CLI via official install script...');
            // Use the official GitHub install script which downloads a pre-built binary
            // The script installs to $HOME/.local/bin by default for non-root users
            // Pass the full command as a single string when using shell: true
            command = 'curl -fsSL https://gh.io/copilot-install | bash';
            args = [];
        }
        
        const installProcess = child_process.spawn(
            command,
            args,
            {
                shell: true,
                stdio: 'inherit'
            }
        );

        installProcess.on('close', (code: number | null) => {
            if (code === 0) {
                console.log('GitHub Copilot CLI installed successfully.');
                // On Linux, add the install location to PATH for the current process
                if (!isWindows()) {
                    const homeDir = process.env['HOME'] || '';
                    const localBin = path.join(homeDir, '.local', 'bin');
                    process.env['PATH'] = `${localBin}:${process.env['PATH']}`;
                    console.log(`Added ${localBin} to PATH.`);
                }
                resolve();
            } else {
                reject(new Error(`Failed to install GitHub Copilot CLI. Exit code: ${code}`));
            }
        });

        installProcess.on('error', (err: Error) => {
            reject(new Error(`Failed to install GitHub Copilot CLI: ${err.message}`));
        });
    });
}

async function runPowerShellScript(scriptPath: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const command = `pwsh -NoProfile -File "${scriptPath}" ${args.join(' ')}`;
        const envVars = { ...process.env };
        
        const psProcess = child_process.spawn(command, [], {
            shell: true,
            stdio: 'inherit',
            env: envVars
        });

        psProcess.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`PowerShell script failed with exit code: ${code}`));
            }
        });

        psProcess.on('error', (err) => {
            reject(new Error(`Failed to run PowerShell script: ${err.message}`));
        });
    });
}

async function runCopilotCli(promptFilePath: string, model: string | undefined, workingDirectory: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        // Build PowerShell command that reads prompt file and passes content to copilot CLI
        // This mirrors the original implementation: $prompt = Get-Content -Path "prompt.txt" -Raw; copilot -p $prompt ...
        let copilotCmd = `copilot -p "$prompt" --allow-all-paths --allow-all-tools --deny-tool 'shell(git push)'`;
        if (model) {
            copilotCmd += ` --model ${model}`;
        }
        
        const printPrompt = `Write-Host ========== START PROMPT ==========; Write-Host $prompt; Write-Host ========== END PROMPT ==========;`;
        const envRefresh = `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User");`
        const psCommand = `${envRefresh} $prompt = Get-Content -Path '${promptFilePath}' -Raw; ${printPrompt} ${copilotCmd}`;
        console.log(`Running Powershell: ${psCommand}`);
        
        const envVars = { ...process.env };
        
        const copilotProcess = child_process.spawn(
            'pwsh',
            ['-NoProfile', '-Command', psCommand],
            {
                shell: false,
                stdio: 'inherit',
                cwd: workingDirectory,
                env: envVars
            }
        );

        // Set up timeout
        const timeoutId = setTimeout(() => {
            console.log(`\nTimeout reached (${timeoutMs / 60000} minutes). Terminating Copilot process...`);
            copilotProcess.kill('SIGTERM');
            reject(new Error(`Copilot review timed out after ${timeoutMs / 60000} minutes`));
        }, timeoutMs);

        copilotProcess.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Copilot CLI exited with code: ${code}`));
            }
        });

        copilotProcess.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(new Error(`Failed to run Copilot CLI: ${err.message}`));
        });
    });
}

run();
