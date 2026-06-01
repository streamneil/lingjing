// 浮层 / 侧滑 / 全屏 sheet 控制
function openModal(id){ document.getElementById('ov-'+id)?.classList.add('show'); }
function closeModal(id){ document.getElementById('ov-'+id)?.classList.remove('show'); }

function openSheet(id){
  if(id==='voices'){ document.getElementById('ov-voicesBg')?.classList.add('show'); }
  document.getElementById('sheet-'+id)?.classList.add('show');
}
function closeSheet(id){
  if(id==='voices'){ document.getElementById('ov-voicesBg')?.classList.remove('show'); }
  document.getElementById('sheet-'+id)?.classList.remove('show');
}

// 从全屏 sheet 里再叫出创建角色弹窗
function openModalFromSheet(id){ closeSheet('appearance'); setTimeout(()=>openModal(id), 120); }

// 点遮罩关闭居中弹窗
document.querySelectorAll('.overlay').forEach(ov=>{
  ov.addEventListener('click',e=>{ if(e.target===ov) ov.classList.remove('show'); });
});
// Esc 关闭一切
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    document.querySelectorAll('.overlay.show,.sheet-full.show,.sheet-side.show').forEach(el=>el.classList.remove('show'));
  }
});
