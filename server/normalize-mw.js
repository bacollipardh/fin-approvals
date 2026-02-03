export function normalizeNumbers(req, _res, next){
  const clamp=(n,min,max)=>Math.min(max??n,Math.max(min??n,n));
  const toInt=(v,def=0)=>{ if(v===''||v==null) return def;
    const m=String(v).match(/\d+/g); if(!m) return def;
    return parseInt(m.join(''),10);
  };
  const fix=(obj,key,min,max)=>{
    if(obj && key in obj){ obj[key]=clamp(toInt(obj[key],min??0),min,max); }
  };
  // top-level
  ['quantity','qty','sasi'].forEach(k=>fix(req.body,k,1,999999));
  ['percent','percentage','perqind'].forEach(k=>fix(req.body,k,0,100));
  // items[]
  const items=req.body?.items;
  if(items){
    (Array.isArray(items)?items:Object.values(items)).forEach(it=>{
      if(it && typeof it==='object'){
        ['quantity','qty','sasi'].forEach(k=>fix(it,k,1,999999));
        ['percent','percentage','perqind'].forEach(k=>fix(it,k,0,100));
      }
    });
  }
  next();
}
