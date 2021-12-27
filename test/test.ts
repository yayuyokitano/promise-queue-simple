import { OnRejection, Queue } from "../src/index";
import chai from "chai";
chai.use(require("chai-spies"));
const expect = chai.expect;

interface InputInfo<T> {
  index: number;
  startTime: number;
  fn: () => Promise<T>;
}

interface QueueItem<T> {
  index: number;
  fn: () => Promise<T>;
}

const sleep = async (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const unresolvablePromise = () => new Promise(() => {});
const rejectPromise = () => new Promise((_, reject) => reject());
let resolveObject:{[key:string]:boolean} = {};
const rejectOnce = async (key:string, ms:number = 0) => {
  await sleep(ms);
  if (resolveObject.hasOwnProperty(key)) {
    return key;
  } else {
    resolveObject[key] = true;
    throw key;
  }
};
  

describe("General tests, retryandthrow", () => {
  const queue = new Queue<any>({
    retryIntervals: [1, 2, 3],
    interval: 1,
  });

  it("Should show as empty", () => {
    expect(queue.isEmpty).to.equal(true);
  });

  it("Size should be 0", () => {
    expect(queue.size).to.equal(0);
  });

  it("Should not be running", () => {
    expect(queue.started).to.equal(false);
  });

  it("Should not be stopped", () => {
    expect(queue.stopped).to.equal(false);
  });

  it("ShouldRun should be false", () => {
    expect(queue.shouldRun).to.equal(false);
  });

  it("Should emit enqueue, start, and dequeue event on queue", () => {
    const enqueueSpy = chai.spy();
    const startSpy = chai.spy();
    const dequeueSpy = chai.spy();
    queue.on("enqueue", enqueueSpy);
    queue.on("start", startSpy);
    queue.on("dequeue", dequeueSpy);
    queue.clear();

    expect(queue.enqueue(async() => sleep(50))).to.not.throw;
    expect(enqueueSpy).to.have.been.called.once;
    expect(startSpy).to.have.been.called.once;
    expect(dequeueSpy).to.have.been.called.once;
  });

  it("Should emit resolve, end, and finish within the next 60ms", async () => {
    const resolveSpy = chai.spy();
    const endSpy = chai.spy();
    const finishSpy = chai.spy();
    queue.on("resolve", resolveSpy);
    queue.on("end", endSpy);
    queue.on("finish", finishSpy);
    await sleep(60);
    expect(resolveSpy).to.have.been.called.once;
    expect(endSpy).to.have.been.called.once;
    expect(finishSpy).to.have.been.called.once;
  });

  it("Should be empty", () => {
    expect(queue.isEmpty).to.equal(true);
  });

  it("Should have size 5 after 10 enqueues", () => {
    for (let i = 0; i < 10; i++) {
      queue.enqueue(unresolvablePromise);
    }
    expect(queue.size).to.equal(5);
  });

  it("Should be running", () => {
    expect(queue.started).to.equal(true);
  });

  it("Should be empty after clear", () => {
    queue.clear();
    expect(queue.isEmpty).to.equal(true);
  });

  it("Should not be running", () => {
    expect(queue.started).to.equal(false);
  });

  it("Should be stoppable, and emit stop and end event", () => {
    const stopSpy = chai.spy();
    const endSpy = chai.spy();
    queue.on("stop", stopSpy);
    queue.on("end", endSpy);
    queue.stop();
    expect(queue.started).to.equal(false);
    expect(stopSpy).to.have.been.called.once;
  });

  it("Should be of size 1 after enqueue", () => {
    queue.enqueue(unresolvablePromise);
    expect(queue.size).to.equal(1);
  });

  it("Should emit dequeue event on dequeue", () => {
    const dequeueSpy = chai.spy();
    queue.on("dequeue", dequeueSpy);
    queue.dequeue();
    expect(dequeueSpy).to.have.been.called.once;
  });

  it("Should be empty after dequeue", () => {
    expect(queue.isEmpty).to.equal(true);
  });

  it("Should not be running", () => {
    expect(queue.started).to.equal(false);
  });

  it("Should resolve after clearing, starting and enqueuing", async () => {
    queue.clear();
    queue.start();
    const resolveSpy = chai.spy();
    queue.on("resolve", resolveSpy);
    queue.enqueue(async() => sleep(20));
    await sleep(50);
    expect(resolveSpy).to.have.been.called.once;
  });

  it("Should emit retry and prepareRetry 3 times, fail once, and not reject, on enqueuing rejecting promise", async () => {
    const rejectSpy = chai.spy();
    const retrySpy = chai.spy();
    const prepareRetrySpy = chai.spy();
    const failSpy = chai.spy();
    queue.on("reject", rejectSpy);
    queue.on("retry", retrySpy);
    queue.on("prepareRetry", prepareRetrySpy);
    queue.on("fail", failSpy);
    queue.clear();
    queue.enqueue(rejectPromise);
    await sleep(10);
    expect(rejectSpy).to.not.have.been.called;
    expect(retrySpy).to.have.been.called.exactly(3);
    expect(prepareRetrySpy).to.have.been.called.exactly(3);
    expect(failSpy).to.have.been.called.once;
  });

  it("Should emit retry once and resolve once on enqueuing promise that fails the first time, and succeeds the second time", async () => {
    const retrySpy = chai.spy();
    const resolveSpy = chai.spy();
    queue.on("retry", retrySpy);
    queue.on("resolve", resolveSpy);
    queue.clear();
    resolveObject = {};
    queue.enqueue(() => rejectOnce("a"));
    await sleep(10);
    expect(retrySpy).to.have.been.called.once;
    expect(resolveSpy).to.have.been.called.once;
  });
  
  it("Should emit retry and resolve ten times when enqueuing ten promises that fail the first time, and succeed the second time", async () => {
    const retrySpy = chai.spy();
    const resolveSpy = chai.spy();
    queue.on("retry", retrySpy);
    queue.on("resolve", resolveSpy);
    queue.clear();
    resolveObject = {};
    for (let i = 0; i < 10; i++) {
      queue.enqueue(() => rejectOnce(i.toString(), (10 - i) * 3));
    }
    await sleep(100);
    expect(resolveSpy).to.have.been.called.exactly(10);
    expect(retrySpy).to.have.been.called.exactly(10);
  });

  it("Should emit 10 retried resolves in the correct order", async () => {
    queue.clear();
    queue.removeAllListeners();
    let res:string[] = [];
    queue.on("resolve", (data) => {
      res.push(data);
    });
    resolveObject = {};
    for (let i = 0; i < 10; i++) {
      queue.enqueue(() => rejectOnce(i.toString(), (10 - i) * 5));
    }
    await sleep(200);
    expect(res).to.deep.equal(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("Should emit 5 retried resolves in the correct order with fails between", async () => {
    queue.clear();
    queue.removeAllListeners();
    let res:string[] = [];
    queue.on("resolve", (data) => {
      res.push(data);
    });
    resolveObject = {};
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        queue.enqueue(() => rejectOnce(i.toString(), (10 - i) * 5));
      } else {
        queue.enqueue(rejectPromise);
      }
    }
    await sleep(1000);
    expect(res).to.deep.equal(["0", "2", "4", "6", "8"]);
  });
});

describe("Queue with ignore errors", () => {
  const queue = new Queue<any>({
    onRejection: OnRejection.IGNORE,
    interval: 1,
    concurrent: 1
  });

  it("Should emit reject and end when fed rejecting function", async () => {
    const rejectSpy = chai.spy();
    const endSpy = chai.spy();
    const resolveSpy = chai.spy();
    queue.on("reject", rejectSpy);
    queue.on("end", endSpy);
    queue.on("resolve", resolveSpy);
    queue.clear();
    queue.enqueue(rejectPromise);
    await sleep(10);
    expect(rejectSpy).to.have.been.called.once;
    expect(endSpy).to.have.been.called.once;
    expect(resolveSpy).to.not.have.been.called;
  });

  it("Should be empty after queuing a rejecting and a resolving function", async () => {
    queue.stop();
    queue.clear();
    queue.enqueue(rejectPromise);
    queue.enqueue(async() => sleep(0));
    queue.start();
    await sleep(10);
    expect(queue.isEmpty).to.equal(true);
  });

});

describe("Queue with retryCondition on retry then throw", () => {
  const queue = new Queue<any>({
    onRejection: OnRejection.RETRY_THEN_THROW,
    interval: 1,
    concurrent: 1,
    retryCondition: () => {
      return {
        retry: false
      };
    }
  });

  it("Should fail on queuing promise that rejects once", async () => {
    const failSpy = chai.spy();
    queue.on("fail", failSpy);
    queue.clear();
    resolveObject = {};
    queue.enqueue(() => rejectOnce("a", 1));
    await sleep(10);
    expect(failSpy).to.have.been.called.once;
  });

  it("Should contain one item after queuing a rejecting and a resolving function", async () => {
    queue.stop();
    queue.clear();
    queue.enqueue(rejectPromise);
    queue.enqueue(async() => sleep(0));
    queue.start();
    await sleep(10);
    expect(queue.size).to.equal(1);
  });
});

describe("Queue with retryCondition on retry then ignore", () => {
  const queue = new Queue<any>({
    onRejection: OnRejection.RETRY_THEN_IGNORE,
    interval: 1,
    concurrent: 1,
    retryCondition: () => {
      return {
        retry: false
      };
    }
  });

  it("Should not resolve on queuing promise that rejects once", async () => {
    const resolveSpy = chai.spy();
    queue.on("resolve", resolveSpy);
    queue.clear();
    resolveObject = {};
    queue.enqueue(() => rejectOnce("a", 1));
    await sleep(10);
    expect(resolveSpy).to.not.have.been.called;
    expect(queue.isEmpty).to.equal(true);
  });

  it("Should be empty after queuing a rejecting and a resolving function", async () => {
    queue.stop();
    queue.clear();
    queue.enqueue(rejectPromise);
    queue.enqueue(async() => sleep(0));
    queue.start();
    await sleep(10);
    expect(queue.isEmpty).to.equal(true);
  });
});

describe("Queue without retryCondition on retry then ignore", () => {
  const queue = new Queue<any>({
    onRejection: OnRejection.RETRY_THEN_IGNORE,
    interval: 1,
    concurrent: 1,
    retryIntervals: [1, 2, 3]
  });

  it("Should not resolve on queuing promise that rejects once", async () => {
    const resolveSpy = chai.spy();
    queue.on("resolve", resolveSpy);
    queue.clear();
    resolveObject = {};
    queue.enqueue(() => rejectOnce("a", 1));
    await sleep(10);
    expect(resolveSpy).to.not.have.been.called;
    expect(queue.isEmpty).to.equal(true);
  });

  it("Should be empty after queuing a rejecting and a resolving function", async () => {
    const resolveSpy = chai.spy();
    const rejectSpy = chai.spy();
    queue.on("resolve", resolveSpy);
    queue.on("reject", rejectSpy);
    queue.stop();
    queue.clear();
    queue.enqueue(rejectPromise);
    queue.enqueue(async() => sleep(0));
    queue.start();
    await sleep(200);
    expect(rejectSpy).to.have.been.called.once;
    expect(resolveSpy).to.have.been.called.once;
    expect(queue.isEmpty).to.equal(true);
  });
});