import { Stream } from "stream";

export class StringStream extends Stream.Writable {
    private lines: string[] = [];
    constructor() {
        super();
        Stream.Writable.call(this);
    }

    // tslint:disable-next-line:variable-name
    public _write(data: any, _encoding: string, next: (err?: Error | null | undefined) => void) {
        const str: string = data.toString();
        this.lines.push(str ? str.trim() : "");
        next();
    }

    public getLines(): string[] {
        return this.lines;
    }

    public getLastLine(): string {
        return this.lines && this.lines.length > 0
            ? this.lines[this.lines.length - 1]
            : "";
    }
}