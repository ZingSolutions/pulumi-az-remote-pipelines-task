import { checkPulumiInstallAsync, runPulumiProgramAsync } from './pulumi';
import { getServiceEndpoint } from './utils/serviceEndpoint';
import { InputNames } from './models/InputNames';
import * as tl from 'azure-pipelines-task-lib/task';
import * as path from 'path';
import Axios from 'axios';

// tslint:disable-next-line: no-floating-promises
(async () => {
    try {
        tl.debug('task starting ...');
        tl.setResourcePath(path.join(__dirname, "task.json"));

        //validate stack name
        const stackName = tl.getInput(InputNames.PULUMI_STACK, true);
        if (!(new RegExp(/^[a-zA-Z][a-zA-Z0-9.-]+$/)).test(stackName)) {
            throw new Error(`Invalid stack name, ${stackName}.
            Name must only contain alphanumeric characters, hyphens or periods and must start with a letter.`);
        }

        //validate rm services
        tl.debug('checking specified azure subscriptions have service endpoint configured ...');
        const remoteStoreAndVaultServiceEndpoint = getServiceEndpoint(tl.getInput(InputNames.AZURE_SUBSCRIPTION_REMOTE_STORE_AND_VAULT, true));
        tl.debug(`remote store and vault service endpoint retrieved with client ID ${remoteStoreAndVaultServiceEndpoint.clientId}`);
        const deploymentServiceEndpoint = getServiceEndpoint(tl.getInput(InputNames.AZURE_SUBSCRIPTION_DEPLOYMENT, true));
        tl.debug(`remote store and vault service endpoint retrieved with client ID ${deploymentServiceEndpoint.clientId}`);

        //validate pulumi verison
        tl.debug('verifying pulumi install');
        let pulumiVersion: string = tl.getInput(InputNames.PULUMI_VERSION, true);
        if (pulumiVersion && pulumiVersion.toLowerCase() !== 'latest') {
            tl.debug(`requested Pulumi Version is: ${pulumiVersion}`);
        }
        else {
            tl.debug('latest version of pulimi requested, checking version required now');
            pulumiVersion = (await Axios.get<string>('https://pulumi.io/latest-version', {
                headers: {
                    "Content-Type": "text/plain",
                    "User-Agent": "pulumi-az-remote-pipelines-task",
                },
            })).data.trim();
            if (!pulumiVersion) {
                throw new Error("failed to get latest version of pulumi from api call to: https://pulumi.io/latest-version");
            }
            tl.debug(`no specific version of Pulumi requested, will use latest: ${pulumiVersion}`);
        }

        tl.debug('check install of pulumi');
        await checkPulumiInstallAsync(pulumiVersion);

        tl.debug('pulumi installed, about to run pulumi program');
        await runPulumiProgramAsync(stackName, remoteStoreAndVaultServiceEndpoint, deploymentServiceEndpoint);

        tl.setResult(tl.TaskResult.Succeeded, "pulumi progam complete");
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err, true);
    }
})();