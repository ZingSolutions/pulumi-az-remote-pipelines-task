import { StringStream } from "models/StringStream";
import { IExecOptions } from "azure-pipelines-task-lib/toolrunner";

export function getExecOptions(envArgs?: { [key: string]: string }, workingDirectory?: string, outStream?: StringStream): IExecOptions {
    // tslint:disable-next-line:variable-name
    const _envArgs: { [key: string]: string } = {};
    _envArgs["PATH"] = process.env["PATH"] || "";

    return {
        //set working directory (default to current)
        cwd: workingDirectory || ".",
        //set path args (default to just current PATH)
        env: envArgs || _envArgs,
        errStream: process.stderr,
        failOnStdErr: false,
        ignoreReturnCode: true,
        //set out stream (default to stdout)
        outStream: outStream ? outStream : process.stdout,
        silent: false,
        windowsVerbatimArguments: false,
    };
}