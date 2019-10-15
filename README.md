# pulumi-az-remote-pipelines-task

## Overview
Azure Pipelines Task for installing Pulumi and running a Pulumi program under an Azure environment where state is stored in blob storage and secrets are encrypted via a key vault key.

## Supported Pulumi Commands

The plugin supports the following Pulumi commands.

- **stack init** - initilises a new stack, with a new secret stored in keyvault to encrypt secrets. On success will create new stack.Pulumi file in working directory. Note: will error if stack already exists in azure storage backend store *(use stack exists command to check for existing stack first)*.

- **stack exists** - checks if the given stack exists in the remote blob storage account. Will write the result (either `"true"` or `"false"`) to the job level environment vairiable named in the Output Variable setting, defaults to `STACK_EXISTS_RESULT`.

- **update config** - loops over all environment variables for the current job. For any environment variable that is prefixed with one of the prefixes defined in the Config Prefix setting, (comma seperated, case insensitive, defaults to `PULUMI_`), will write the name (excluding the prefix) and value as a config option for the given stack. Note: if the variable is marked as secret this will be written as secret in the config as well. Once complete will set the status of this action to the job level environment variable named in the Output Variable setting, defaults to `STACK_CONFIG_UPDATE_RESULT`. Possible values are `"some_change"` or `"no_change"`.

- **preview** - runs the pulumi [preview](https://www.pulumi.com/docs/reference/cli/pulumi_preview/) command with any optional options specified in the Command Args setting. If the Output FilePath setting is set to a valid filePath the Output of the preview command will also be written to disk at the given filePath.

- **up** - runs the pulumi [up](https://www.pulumi.com/docs/reference/cli/pulumi_up/) command with any optional options specified in the Command Args setting. If the Output FilePath setting is set to a valid filePath the Output of the up command will also be written to disk at the given filePath.

- **destroy** - runs the pulumi [destroy](https://www.pulumi.com/docs/reference/cli/pulumi_destroy/) command with any optional options specified in the Command Args setting. If the Output FilePath setting is set to a valid filePath the Output of the destroy command will also be written to disk at the given filePath.