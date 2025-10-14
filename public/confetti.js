'use strict';

(function () {
  var random = Math.random,
      cos = Math.cos,
      sin = Math.sin,
      PI = Math.PI,
      PI2 = PI * 2,
      timer = undefined,
      frame = undefined,
      confetti = [];

  var particles = 10,
      spread = 40,
      sizeMin = 3,
      sizeMax = 12 - sizeMin,
      eccentricity = 10,
      deviation = 100,
      dxThetaMin = -.1,
      dxThetaMax = -dxThetaMin - dxThetaMin,
      dyMin = .13,
      dyMax = .18,
      dThetaMin = .4,
      dThetaMax = .7 - dThetaMin;

  var colorThemes = [
    function () { return color(200*random()|0, 200*random()|0, 200*random()|0); },
    function () { var b = 200*random()|0; return color(200, b, b); },
    function () { var b = 200*random()|0; return color(b, 200, b); },
    function () { var b = 200*random()|0; return color(b, b, 200); },
    function () { return color(200, 100, 200*random()|0); },
    function () { return color(200*random()|0, 200, 200); },
    function () { var b = 256*random()|0; return color(b, b, b); },
    function () { return colorThemes[random() < .5 ? 1 : 2](); },
    function () { return colorThemes[random() < .5 ? 3 : 5](); },
    function () { return colorThemes[random() < .5 ? 2 : 4](); }
  ];
  function color(r,g,b){ return 'rgb('+r+','+g+','+b+')'; }

  function interpolation(a,b,t){ return (1-cos(PI*t))/2 * (b-a) + a; }

  var radius = 1/eccentricity, radius2 = radius+radius;
  function createPoisson(){
    var domain = [radius, 1-radius], measure = 1-radius2, spline = [0, 1];
    while (measure) {
      var dart = measure*random(), i, l, interval, a, b, c, d;
      for (i=0, l=domain.length, measure=0; i<l; i+=2) {
        a = domain[i], b = domain[i+1], interval = b-a;
        if (dart < measure+interval) { spline.push(dart += a-measure); break; }
        measure += interval;
      }
      c = dart-radius, d = dart+radius;
      for (i = domain.length-1; i > 0; i -= 2) {
        l = i-1, a = domain[l], b = domain[i];
        if (a >= c && a < d) {
          if (b > d) domain[l] = d;
          else domain.splice(l, 2);
        } else if (a < c && b > c) {
          if (b <= d) domain[i] = c;
          else domain.splice(i, 0, c, d);
        }
      }
      for (i=0, l=domain.length, measure=0; i<l; i+=2) measure += domain[i+1]-domain[i];
    }
    return spline.sort();
  }

  var container;
  function ensureContainer(){
    if (container) return container;
    container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100%';
    container.style.height = '0';
    container.style.overflow = 'visible';
    container.style.zIndex = '9999';
    return container;
  }

  function Confetto(theme){
    this.frame = 0;
    this.outer = document.createElement('div');
    this.inner = document.createElement('div');
    this.outer.appendChild(this.inner);

    var outerStyle = this.outer.style, innerStyle = this.inner.style;
    outerStyle.position = 'absolute';
    outerStyle.width = (sizeMin + sizeMax * random()) + 'px';
    outerStyle.height = (sizeMin + sizeMax * random()) + 'px';
    innerStyle.width = '100%'; innerStyle.height = '100%';
    innerStyle.backgroundColor = theme();

    outerStyle.perspective = '50px';
    outerStyle.transform = 'rotate(' + (360 * random()) + 'deg)';
    this.axis = 'rotate3D(' + cos(360*random()) + ',' + cos(360*random()) + ',0,';
    this.theta = 360*random();
    this.dTheta = dThetaMin + dThetaMax*random();
    innerStyle.transform = this.axis + this.theta + 'deg)';

    this.x = window.innerWidth * random();
    this.y = -deviation;
    this.dx = sin(dxThetaMin + dxThetaMax*random());
    this.dy = dyMin + dyMax*random();
    outerStyle.left = this.x + 'px';
    outerStyle.top  = this.y + 'px';

    this.splineX = createPoisson();
    this.splineY = [];
    for (var i=1, l=this.splineX.length-1; i<l; ++i) this.splineY[i] = deviation*random();
    this.splineY[0] = this.splineY[l] = deviation*random();

    this.update = function(height, delta){
      this.frame += delta;
      this.x += this.dx * delta;
      this.y += this.dy * delta;
      this.theta += this.dTheta * delta;
      var phi = this.frame % 7777 / 7777, i = 0, j = 1;
      while (phi >= this.splineX[j]) i = j++;
      var rho = interpolation(this.splineY[i], this.splineY[j], (phi-this.splineX[i])/(this.splineX[j]-this.splineX[i]));
      phi *= PI2;
      outerStyle.left = this.x + rho * cos(phi) + 'px';
      outerStyle.top  = this.y + rho * sin(phi) + 'px';
      this.inner.style.transform = this.axis + this.theta + 'deg)';
      return this.y > height + deviation;
    };
  }

  function startConfetti(themeIndex, durationMs) {
    if (frame) return; // already running
    var theme = colorThemes[themeIndex || 0];
    var cont = ensureContainer();
    document.body.appendChild(cont);

    var endAt = performance.now() + (typeof durationMs === 'number' ? durationMs : 5000);

    // add pieces periodically until endAt
    (function addConfetto(){
      var now = performance.now();
      if (now >= endAt) {
        // stop adding new confetti
        timer = undefined;
        return;
      }
      var confetto = new Confetto(theme);
      confetti.push(confetto);
      cont.appendChild(confetto.outer);
      timer = setTimeout(addConfetto, spread * Math.random());
    })();

    var prev;
    function loop(ts){
      var delta = prev ? ts - prev : 0; prev = ts;
      var height = window.innerHeight;

      for (var i = confetti.length - 1; i >= 0; --i) {
        if (confetti[i].update(height, delta)) {
          cont.removeChild(confetti[i].outer);
          confetti.splice(i, 1);
        }
      }

      // if we still have a timer or confetti on screen, keep animating
      if (timer || confetti.length) {
        frame = requestAnimationFrame(loop);
      } else {
        // cleanup
        if (cont.parentNode) cont.parentNode.removeChild(cont);
        frame = undefined;
      }
    }
    frame = requestAnimationFrame(loop);
  }

  function hardStopConfetti(){
    // Immediately stop adding and remove everything
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (frame) { cancelAnimationFrame(frame); frame = undefined; }
    if (container && container.parentNode) {
      // remove remaining confetti nodes
      try { while (container.firstChild) container.removeChild(container.firstChild); } catch {}
      container.parentNode.removeChild(container);
    }
    confetti.length = 0;
  }

  // Expose a global function you can call from app.js
  window.triggerConfetti = function(themeIndex){ startConfetti(themeIndex); };
  window.stopConfetti = function(){ hardStopConfetti(); };
})();