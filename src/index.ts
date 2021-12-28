import { EventEmitter } from "events";

export enum OnRejection {
  THROW,
  RETRY_THEN_THROW,
  IGNORE,
  RETRY_THEN_IGNORE
}

interface QueueOptions {
  interval?: number;
  concurrent?: number;
  start?: boolean;
  guaranteeOrder?: boolean;
  onRejection?: OnRejection;
  retryIntervals?: number[];
  alwaysRetry?: boolean;
  retryCondition?: (error: any) => {
    retry: boolean;
    interval?: number;
  };
}

interface QueueItem<T> {
  index: number;
  fn: () => Promise<T>;
}

interface InputInfo<T> {
  index: number;
  startTime: number;
  fn: () => Promise<T>;
}

interface QueueEvents<T> {
  "resolve": (data: T) => void;
  "reject": (error:unknown, inputInfo:InputInfo<T>) => void;
  "fail": (error: unknown) => void;
  "start": () => void;
  "stop": () => void;
  "end": () => void;
  "finish": () => void;
  "prepareRetry": (error:unknown, retryIn:number, inputInfo:InputInfo<T>) => void;
  "retry": (inputInfo:InputInfo<T>) => void;
  "dequeue": (inputInfo:InputInfo<T>) => void;
  "enqueue": (inputInfo:QueueItem<T>) => void;
}

export interface Queue<T> extends EventEmitter {
  on<U extends keyof QueueEvents<T>>(
    event: U, listener: QueueEvents<T>[U]
  ): this;

  emit<U extends keyof QueueEvents<T>>(
    event: U, ...args: Parameters<QueueEvents<T>[U]>
  ): boolean;
}

const sleep = async(ms:number) => new Promise(resolve => setTimeout(resolve, ms));

export class Queue<T> extends EventEmitter{
  private interval:number;
  private concurrent:number;
  private startOnAdd:boolean;
  private guaranteeOrder:boolean;
  private onRejection:OnRejection;
  private retryIntervals:number[];
  private alwaysRetry:boolean;
  private retryCondition: ((error: any) => {
    retry: boolean;
    interval?: number;
  }) | null;

  private runningCount = 0;
  private queue = new Array<() => Promise<T>>();
  private resolveObject:{[key:string]: {
    res: T;
    inputInfo: InputInfo<T>;
  }} = {};
  private rejectObject:{[key:string]: unknown} = {};
  private index = 0;
  private completed = 0;
  private isRunning = false;

  public constructor(options?:QueueOptions) {
    super();

    this.interval = options?.interval ?? 500;
    this.concurrent = options?.concurrent ?? 5;
    this.startOnAdd = options?.start ?? true;
    this.guaranteeOrder = options?.guaranteeOrder ?? true;
    this.onRejection = options?.onRejection ?? OnRejection.RETRY_THEN_THROW;
    this.retryIntervals = options?.retryIntervals ?? [1000, 2000, 5000, 10000, 20000, 60000];
    this.alwaysRetry = options?.alwaysRetry ?? false;
    this.retryCondition = options?.retryCondition ?? null;
  }

  private async continue(inputInfo:InputInfo<T>) {
    this.runningCount--;
    await sleep(Math.max(0, inputInfo.startTime + this.interval - Date.now()));
    if (this.started) {
      this.dequeue();
    }
  }

  private fail(err:unknown) {
    if (this.started) {
      this.emit("fail", err);
      this.end();
    }
  }

  private async attemptEmit(res:T, inputInfo:InputInfo<T>) {
    if (this.guaranteeOrder) {
      this.resolveObject[inputInfo.index] = {
        res,
        inputInfo
      };

      while (this.resolveObject.hasOwnProperty(this.completed.toString()) || this.rejectObject.hasOwnProperty(this.completed.toString())) {
        if (this.resolveObject.hasOwnProperty(this.completed.toString())) {
          this.emit("resolve", this.resolveObject[this.completed].res);
          delete this.resolveObject[this.completed];
        } else if (this.rejectObject.hasOwnProperty(this.completed.toString())) {
          delete this.rejectObject[this.completed];
        }
        this.completed++;

      }

    } else {
      this.emit("resolve", res);
    }
    this.continue(inputInfo);
    
  }

  private rejectAndContinue(err:unknown, inputInfo:InputInfo<T>) {
    this.emit("reject", err, inputInfo);
    this.rejectObject[inputInfo.index.toString()] = err;
    this.runningCount--;
    this.dequeue();
  }

  private async attemptRetry(interval:number|undefined, retryCount:number, err:unknown, inputInfo:InputInfo<T>) {
    if (this.alwaysRetry || retryCount < this.retryIntervals.length) {
      const retryIn = interval ?? this.retryIntervals[retryCount] ?? this.retryIntervals[this.retryIntervals.length - 1];
      this.emit("prepareRetry", err, retryIn, inputInfo);
      await sleep(retryIn);
      this.emit("retry", inputInfo);
      try {
        const res = await inputInfo.fn();
        this.attemptEmit(res, inputInfo);
      } catch (err) {
        this.handleRejection(err, inputInfo, retryCount + 1);
      }

    } else {
      if (this.onRejection === OnRejection.RETRY_THEN_THROW) {
        this.fail(err);
      } else {
        this.rejectAndContinue(err, inputInfo);
      }
    }
  }

  private async handleRejection(err:unknown, inputInfo:InputInfo<T>, retryCount:number) {
    switch (this.onRejection) {
      case OnRejection.THROW: {
        this.fail(err);
        break;
      }
        
      case OnRejection.RETRY_THEN_THROW: {
        const shouldRetry = this.retryCondition?.(err);
        if (shouldRetry?.retry ?? true) {
          await this.attemptRetry(shouldRetry?.interval, retryCount, err, inputInfo);
        } else {
          this.fail(err);
        }
        break;
      }
      
      case OnRejection.IGNORE: {
        this.rejectAndContinue(err, inputInfo);
        break;
      }
      
      case OnRejection.RETRY_THEN_IGNORE: {
        const shouldRetry = this.retryCondition?.(err);
        if (shouldRetry?.retry ?? true) {
          await this.attemptRetry(shouldRetry?.interval, retryCount, err, inputInfo);
        } else {
          this.rejectAndContinue(err, inputInfo);
        }
        break;
      }
    }
  }

  public async dequeue() {
    const promise = this.queue.shift();
    if (promise) {
      const startTime = Date.now();
      this.runningCount++;
      const index = this.index;
      this.index++;
      const inputInfo = {
        index,
        fn: promise,
        startTime
      };
      this.emit("dequeue", inputInfo);
      try {
        const res = await promise()
        this.attemptEmit(res, inputInfo);
      } catch(err) {
        this.handleRejection(err, inputInfo, 0);
      }
    } else {
      this.end();
      this.emit("finish");
    }
  }

  public start() {
    this.isRunning = true;
    this.startOnAdd = true;
    this.emit("start");
    while (this.shouldRun) {
      this.dequeue();
    }
  }

  private end() {
    if (this.started) {
      this.isRunning = false;
      this.emit("end");
    }
  }

  public stop() {
    this.startOnAdd = false;
    this.emit("stop");
    this.end();
  }

  public enqueue(promise:() => Promise<T>) {
    this.queue.push(promise);
    this.emit("enqueue", {
      index: this.queue.length - 1,
      fn: promise
    });
    if (this.shouldRun && this.startOnAdd) {
      this.start();
    }
  }
  
  public clear() {
    this.queue = [];
    this.resolveObject = {};
    this.rejectObject = {};
    this.index = 0;
    this.completed = 0;
    this.isRunning = false;
    this.runningCount = 0;
  }

  public get size(){
    return this.queue.length;
  }

  public get isEmpty(){
    return this.size === 0;
  }

  public get shouldRun() {
    return this.runningCount < this.concurrent && !this.isEmpty;
  }

  public get started() {
    return this.isRunning;
  }

  public get stopped() {
    return !this.startOnAdd && !this.started;
  }
};