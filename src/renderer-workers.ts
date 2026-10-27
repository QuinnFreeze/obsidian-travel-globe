/** Workers created by the bundled engine are scoped to this plugin instance, never other plugins. */
export class RendererWorkers {
  readonly Worker:typeof Worker;
  private workers=new Set<Worker>();private stopped=false;
  constructor(BaseWorker:typeof Worker){
    const scope=this;
    this.Worker=class extends BaseWorker {
      constructor(url:string|URL,options?:WorkerOptions){
        if(scope.stopped)throw Error('旅行地球已关闭');
        super(url,options);scope.workers.add(this);
      }
      terminate(){scope.workers.delete(this);super.terminate();}
    };
  }
  get size(){return this.workers.size;}
  dispose(){
    this.stopped=true;
    for(const worker of [...this.workers]){
      try{worker.terminate();}catch{}
    }
    this.workers.clear();
  }
}
