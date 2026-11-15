// hud.js — every DOM write in the game lives here, and every text update
// is value-cached so the DOM is only touched when a value actually
// changes. Displayed health and timer are clamped to 0 — a negative number
// on screen is never a bug the player should see.

export function createHud(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const el = (id) => (d ? d.getElementById(id) : null);
  const els = {
    healthBar: el('healthBar'),
    healthNum: el('healthNum'),
    armorNum: el('armorNum'),
    ammoMag: el('ammoMag'),
    ammoReserve: el('ammoReserve'),
    weaponName: el('weaponName'),
    grenadeNum: el('grenadeNum'),
    moneyNum: el('moneyNum'),
    scoreEmber: el('scoreEmber'),
    scoreSlate: el('scoreSlate'),
    timerText: el('timerText'),
    killfeed: el('killfeed'),
    bombBanner: el('bombBanner'),
    bombBannerText: el('bombBannerText'),
    roundBanner: el('roundBanner'),
    roundBannerTitle: el('roundBannerTitle'),
    roundBannerSub: el('roundBannerSub'),
    channelWrap: el('channelWrap'),
    channelLabel: el('channelLabel'),
    channelFill: el('channelFill'),
    hintLine: el('hintLine'),
    buyMenu: el('buyMenu'),
    buyList: el('buyList'),
    crosshair: el('crosshair'),
    hitmarker: el('hitmarker'),
    vignette: el('vignette'),
    overlayStart: el('overlayStart'),
    overlayPause: el('overlayPause'),
    overlayDown: el('overlayDown'),
    overlayMatch: el('overlayMatch'),
    matchTitle: el('matchTitle'),
    matchSub: el('matchSub'),
  };
  const cache = {};
  const setText = (node, key, value) => {
    if (!node || cache[key] === value) return;
    cache[key] = value;
    node.textContent = value;
  };
  const setWidth = (node, key, pct) => {
    if (!node || cache[key] === pct) return;
    cache[key] = pct;
    node.style.width = `${pct}%`;
  };
  const setClass = (node, key, on, cls) => {
    if (!node) return;
    const k = `${key}:${cls}`;
    if (cache[k] === on) return;
    cache[k] = on;
    node.classList.toggle(cls, on);
  };

  return {
    els,

    setHealth(hp) {
      const shown = Math.max(0, Math.ceil(hp));
      setText(els.healthNum, 'hp', String(shown));
      setWidth(els.healthBar, 'hpbar', Math.max(0, Math.min(100, hp)));
      setClass(els.healthNum, 'hplow', hp <= 30, 'low');
      setClass(els.healthBar, 'hpbarlow', hp <= 30, 'low');
    },

    setArmor(a) {
      setText(els.armorNum, 'armor', a > 0 ? `ARMOR ${Math.ceil(a)}` : '');
    },

    setAmmo(mag, reserve, name) {
      setText(els.ammoMag, 'mag', String(mag));
      setText(els.ammoReserve, 'res', String(reserve));
      setText(els.weaponName, 'wname', name);
      setClass(els.ammoMag, 'magempty', mag === 0, 'empty');
    },

    setGrenades(n) {
      setText(els.grenadeNum, 'nades', `GRENADES ${n}`);
    },

    setMoney(m) {
      setText(els.moneyNum, 'money', `$${m}`);
    },

    setScore(e, s) {
      setText(els.scoreEmber, 'se', String(e));
      setText(els.scoreSlate, 'ss', String(s));
    },

    setTimer(seconds, phase) {
      const t = Math.max(0, Math.ceil(seconds));
      const text = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      setText(els.timerText, 'timer', text);
      setClass(els.timerText, 'timerlow', phase === 'live' && t <= 10, 'low');
    },

    setBombBanner(text) {
      if (!els.bombBanner) return;
      const show = !!text;
      if (cache.bombBannerShow !== show) {
        cache.bombBannerShow = show;
        els.bombBanner.style.display = show ? 'block' : 'none';
      }
      if (show) setText(els.bombBannerText, 'bomb', text);
    },

    showRoundBanner(title, sub) {
      setText(els.roundBannerTitle, 'rbtitle', title);
      setText(els.roundBannerSub, 'rbsub', sub);
      if (els.roundBanner && cache.rbShow !== true) {
        cache.rbShow = true;
        els.roundBanner.style.display = 'block';
      }
    },

    hideRoundBanner() {
      if (els.roundBanner && cache.rbShow !== false) {
        cache.rbShow = false;
        els.roundBanner.style.display = 'none';
      }
    },

    feed(killer, victim, head) {
      if (!els.killfeed || !d) return;
      const row = d.createElement('div');
      row.className = 'feed-row';
      row.textContent = head
        ? `${killer} \u2715 ${victim} (headshot)`
        : `${killer} \u2715 ${victim}`;
      els.killfeed.prepend(row);
      while (els.killfeed.children.length > 5) {
        els.killfeed.removeChild(els.killfeed.lastChild);
      }
      setTimeout(() => {
        if (row.parentNode) row.parentNode.removeChild(row);
      }, 5000);
    },

    clearFeed() {
      if (els.killfeed) els.killfeed.innerHTML = '';
    },

    setChannel(label, frac) {
      if (!els.channelWrap) return;
      const show = frac !== null && frac !== undefined;
      if (cache.chShow !== show) {
        cache.chShow = show;
        els.channelWrap.style.display = show ? 'block' : 'none';
      }
      if (show) {
        setText(els.channelLabel, 'chlabel', label);
        const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
        setWidth(els.channelFill, 'chfill', pct);
      }
    },

    setHint(text) {
      setText(els.hintLine, 'hint', text || '');
    },

    // items: [{key, label, price, owned, afford}]
    setBuyMenu(items, visible) {
      if (!els.buyMenu) return;
      if (cache.buyShow !== visible) {
        cache.buyShow = visible;
        els.buyMenu.style.display = visible ? 'block' : 'none';
      }
      if (!visible || !els.buyList) return;
      const sig = JSON.stringify(items);
      if (cache.buySig === sig) return;
      cache.buySig = sig;
      els.buyList.innerHTML = items.map((it) => {
        const tag = it.owned ? 'OWNED' : it.afford ? `$${it.price}` : `$${it.price} — NO CASH`;
        return `<div class="buy-row${it.owned ? ' owned' : ''}${!it.afford && !it.owned ? ' poor' : ''}"><span>[${it.key}] ${it.label}</span><span>${tag}</span></div>`;
      }).join('');
    },

    setCrosshairGap(px) {
      if (!els.crosshair) return;
      const v = Math.round(px * 10) / 10;
      if (cache.gap === v) return;
      cache.gap = v;
      els.crosshair.style.setProperty('--gap', `${v}px`);
    },

    hitmarker(kill) {
      if (!els.hitmarker) return;
      els.hitmarker.classList.remove('show', 'kill');
      // Force a reflow so a repeated hit re-triggers the animation.
      void els.hitmarker.offsetWidth;
      els.hitmarker.classList.add('show');
      if (kill) els.hitmarker.classList.add('kill');
      setTimeout(() => els.hitmarker.classList.remove('show', 'kill'), 180);
    },

    damageFlash() {
      if (!els.vignette) return;
      els.vignette.classList.remove('flash');
      void els.vignette.offsetWidth;
      els.vignette.classList.add('flash');
      setTimeout(() => els.vignette.classList.remove('flash'), 350);
    },

    // name: 'start' | 'pause' | 'down' | 'match' | null
    showOverlay(name, matchTitle, matchSub) {
      const map = {
        start: els.overlayStart,
        pause: els.overlayPause,
        down: els.overlayDown,
        match: els.overlayMatch,
      };
      for (const key of Object.keys(map)) {
        const node = map[key];
        if (node) node.style.display = key === name ? 'flex' : 'none';
      }
      if (name === 'match') {
        if (matchTitle) setText(els.matchTitle, 'mtitle', matchTitle);
        if (matchSub) setText(els.matchSub, 'msub', matchSub);
      }
    },
  };
}
