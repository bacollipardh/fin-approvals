(function(){
  function fixIntInput(el, min, max){
    el.addEventListener('input', ()=>{
      let v = el.value;
      // lejo bosh gjatë shtypjes
      if (v === '') { el.dataset.empty='1'; return; }
      // hiq jo-numra dhe leading zeros
      v = v.replace(/[^\d]/g,'').replace(/^0+(\d)/,'$1');
      el.value = v;
    });
    el.addEventListener('blur', ()=>{
      let v = el.value;
      if (v === '') v = String(min);
      let n = parseInt(v,10); if (isNaN(n)) n=min;
      if (min!=null && n<min) n=min;
      if (max!=null && n>max) n=max;
      el.value = String(n);
    });
  }
  function attach(){
    document.querySelectorAll('input[name="quantity"],input[name="qty"],input[name="sasi"]').forEach(el=>fixIntInput(el,1,999999));
    document.querySelectorAll('input[name="percent"],input[name="percentage"],input[name="perqind"]').forEach(el=>fixIntInput(el,0,100));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
})();
