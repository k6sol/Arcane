(() => {
  const canvas = document.getElementById('viewport'), ctx = canvas.getContext('2d');
  const slider = document.getElementById('time'), clock = document.getElementById('clock');
  const play = document.getElementById('play'), status = document.getElementById('status');
  const end = ArcaneTimeline.end(effect), hidden = new Set(), sprites = {};
  let yaw = .55, pitch = .32, scale = 35, target = [0,0,0], time = 0, playing = false, light = false, last = null;
  let pointer = null;
  document.getElementById('title').textContent = effect.name;
  slider.max = String(end);
  effect.layers.forEach((layer, i) => {
    const label = document.createElement('label'), box = document.createElement('input');
    box.type = 'checkbox'; box.checked = true;
    box.addEventListener('change', () => { box.checked ? hidden.delete(i) : hidden.add(i); draw(); });
    label.append(box, document.createTextNode(layer.id));
    document.getElementById('layers').append(label);
  });
  function project(p) {
    p = p.map((v,i)=>v-target[i]);
    const unit = scale * Math.min(2, window.devicePixelRatio || 1);
    const x = p[0] * Math.cos(yaw) - p[2] * Math.sin(yaw);
    const z = p[0] * Math.sin(yaw) + p[2] * Math.cos(yaw);
    return [canvas.width / 2 + x * unit, canvas.height * .62 - (p[1] * Math.cos(pitch) - z * Math.sin(pitch)) * unit, z * Math.cos(pitch) + p[1] * Math.sin(pitch)];
  }
  function fitView() {
    const times = effect.layers.map(l=>l.start+(l.burst?0:1/l.rate)+l.life[0]*.3);
    for(let i=0;i<=24;i++) times.push(end*i/24);
    const low=[-.5,-.5,-.5],high=[.5,.5,.5];
    for(const t of times) for(const p of ArcaneTimeline.sample(effect,t)) {
      if(p.alpha<=.01||p.size<=0) continue;
      for(let a=0;a<3;a++) {low[a]=Math.min(low[a],p.position[a]-p.size/2);high[a]=Math.max(high[a],p.position[a]+p.size/2);}
    }
    target=low.map((v,i)=>(v+high[i])/2);
    const extent=Math.max(2,...high.map((v,i)=>v-low[i]));
    const rect=canvas.getBoundingClientRect();
    scale=Math.max(4,Math.min(160,Math.min(rect.width,rect.height)*.7/extent));
  }
  function draw() {
    const ratio = Math.min(2, window.devicePixelRatio || 1), rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * ratio)), h = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = light ? '#d7dce1' : '#171c24'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = light ? '#b8c1cb' : '#2d3846'; ctx.lineWidth = ratio;
    for (let k = -10; k <= 10; k++) {
      for (const endpoints of [[[k,0,-10],[k,0,10]],[[-10,0,k],[10,0,k]]]) {
        const a = project(endpoints[0]), b = project(endpoints[1]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
    const particles = ArcaneTimeline.sample(effect, time).filter(p => !hidden.has(p.layer));
    particles.sort((a,b) => project(a.position)[2] - project(b.position)[2]);
    for (const p of particles) {
      if (p.alpha <= 0 || p.size <= 0) continue;
      const layer = effect.layers[p.layer], frames = sprites[layer.id];
      if (!frames) continue;
      const pos = project(p.position), width = p.size * scale * ratio;
      ctx.globalCompositeOperation = layer.blend === 'add' ? 'lighter' : 'source-over';
      ctx.globalAlpha = p.alpha;
      ctx.drawImage(frames[Math.min(15, Math.floor(p.age * 16))], pos[0] - width/2, pos[1] - width/2, width, width);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    clock.textContent = time.toFixed(3) + ' / ' + end.toFixed(3) + ' s';
    status.textContent = particles.length + ' visible particles · seed ' + effect.seed + ' · grid spacing 1 stud';
  }
  Promise.all(Object.entries(textureSources).map(([key, source]) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const tile = image.width / 4;
      effect.layers.filter(layer => layer.texture === key).forEach(layer => {
        sprites[layer.id] = Array.from({length:16}, (_, frame) => {
          const sprite = document.createElement('canvas'); sprite.width = sprite.height = tile;
          const paint = sprite.getContext('2d');
          paint.fillStyle = 'rgb(' + layer.color.map(c => Math.round(c * 255)).join(',') + ')';
          paint.fillRect(0,0,tile,tile); paint.globalCompositeOperation = 'destination-in';
          paint.drawImage(image, frame%4*tile, Math.floor(frame/4)*tile,tile,tile,0,0,tile,tile);
          return sprite;
        });
      }); resolve();
    };
    image.onerror = () => reject(Error('Generated texture could not be decoded: ' + key));
    image.src = source;
  }))).then(()=>{fitView();draw();}).catch(error => { status.textContent = error.message; });
  function pause() { playing = false; play.textContent = 'Play'; last = null; }
  play.addEventListener('click', () => { if(time>=end){time=0;slider.value='0';} playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; last = null; });
  slider.addEventListener('input', () => { pause(); time = Number(slider.value); draw(); });
  document.getElementById('reset').addEventListener('click', () => { yaw=.55;pitch=.32;fitView();draw(); });
  document.getElementById('background').addEventListener('click', event => { light=!light;event.target.textContent=light?'Dark background':'Light background';draw(); });
  canvas.addEventListener('pointerdown', event => { pointer=[event.clientX,event.clientY];canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => {
    if (!pointer) return;
    yaw += (event.clientX-pointer[0]) * .008; pitch = Math.max(-1.2, Math.min(1.2,pitch+(event.clientY-pointer[1])*.008));
    pointer=[event.clientX,event.clientY]; draw();
  });
  for (const name of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(name, () => {pointer=null;});
  canvas.addEventListener('wheel', event => { event.preventDefault();scale=Math.max(4,Math.min(160,scale*Math.exp(-event.deltaY*.001)));draw(); },{passive:false});
  window.addEventListener('resize', draw);
  document.addEventListener('visibilitychange', () => { if(document.hidden) pause(); });
  function tick(now) {
    if (playing) {
      if (last !== null) time = Math.min(end,time+(now-last)/1000);
      last=now;slider.value=String(time);draw();
      if(time>=end) pause();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick); draw();
})();
