import tl = require('azure-pipelines-task-lib/task');

// tslint:disable-next-line: no-floating-promises
(async () => {
    try {
        const inputString: string = tl.getInput('samplestring', true);
        if (inputString === 'bad') {
            tl.setResult(tl.TaskResult.Failed, 'Bad input was given');
            return;
        }
        console.log('Hello', inputString);
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
})();