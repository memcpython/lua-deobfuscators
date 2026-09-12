class Report {
  constructor(){ this.passes=[]; this.warnings=[]; this.profile={}; }
  addPass(name, changes, details={}) { this.passes.push({name,changes,...details}); }
  warn(message){ this.warnings.push(String(message)); }
  get totalChanges(){ return this.passes.reduce((n,p)=>n+(p.changes||0),0); }
}
module.exports = { Report };
