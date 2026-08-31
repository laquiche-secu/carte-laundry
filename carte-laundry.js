// ==========================================================================
// carte-laundry.js — Carte Lovelace personnalisée pour Home Assistant
// Fonctionne pour un lave-linge OU un sèche-linge, selon l'option
// "appliance_type". Aucune entité à créer côté Home Assistant : la carte
// utilise directement vos capteurs natifs (puissance, courant, énergie)
// et détecte elle-même les cycles + calcule les coûts, à partir de
// paramètres saisis dans la configuration de la carte (seuil, délai,
// prix du kWh...). Tout se configure via l'éditeur graphique.
// ==========================================================================
// Installation :
// 1. Copiez ce fichier dans /config/www/carte-laundry.js
// 2. Paramètres > Tableaux de bord > (⋮) Ressources > Ajouter une ressource
//      URL : /local/carte-laundry.js
//      Type : Module JavaScript
// 3. Ajoutez la carte à votre tableau de bord (Ajouter une carte >
//    "Carte Laundry") : un formulaire graphique permet de tout configurer.
// ==========================================================================

const CLL_TYPES = {
  washer: {
    label: "Lave-linge",
    icon: "mdi:washing-machine",
    cycleWord: "lavages",
    accent: "#37d6c4",
    accentDim: "rgba(55,214,196,0.12)",
    motion: "spin",
  },
  dryer: {
    label: "Sèche-linge",
    icon: "mdi:tumble-dryer",
    cycleWord: "séchages",
    accent: "#f2994a",
    accentDim: "rgba(242,153,74,0.14)",
    motion: "glow",
  },
};

const CLL_DEFAULTS = {
  power_scale_max: 2200,   // W — échelle du hublot
  power_threshold: 8,      // W — au-delà, on considère que ça tourne
  stop_delay_minutes: 4,   // minutes sous le seuil avant de considérer que c'est arrêté (anti-pause)
  min_cycle_minutes: 5,    // durée minimale pour compter un vrai cycle (anti faux-départs)
  price_kwh: 0.2516,       // €/kWh
  history_days: 60,        // profondeur de recherche pour la popup d'historique des cycles
  noise_ignore_seconds: 45, // pics de puissance isolés plus courts que ça = ignorés (bruit)
};

class CarteLaundry extends HTMLElement {
  setConfig(config) {
    if (!config.entity_power) {
      throw new Error("Vous devez définir au minimum 'entity_power'.");
    }
    const applianceType = CLL_TYPES[config.appliance_type] ? config.appliance_type : "washer";
    this.config = {
      appliance_type: applianceType,
      subtitle: "",
      ...CLL_DEFAULTS,
      ...config,
      name: config.name || CLL_TYPES[applianceType].label,
    };
    this._built = false;
  }

  getCardSize() {
    return 5;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._build();
      this._built = true;
      this._bootstrapRunningState();
      this._loadLastCycle();
    }
    this._update();
  }

  get _type() {
    return CLL_TYPES[this.config.appliance_type] || CLL_TYPES.washer;
  }

  _entity(id) {
    return id ? this._hass.states[id] : undefined;
  }

  _num(id, fallback = 0) {
    const st = this._entity(id);
    if (!st || st.state === "unknown" || st.state === "unavailable") return fallback;
    const v = parseFloat(st.state);
    return isNaN(v) ? fallback : v;
  }

  _fmtEuro(v) {
    return (v ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  }

  _fmtDuration(sinceIso) {
    if (!sinceIso) return "00:00";
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(sinceIso).getTime()) / 1000));
    return this._fmtDurationMs(diffSec * 1000);
  }

  _fmtDurationMs(ms) {
    const diffSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60).toString().padStart(2, "0");
    const s = (diffSec % 60).toString().padStart(2, "0");
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  }

  _startOfWeek(d) {
    // Semaine calée sur le lundi (convention française)
    const date = new Date(d);
    const day = date.getDay(); // 0 = dimanche
    const diff = (day === 0 ? -6 : 1) - day;
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  _startOfMonth(d) {
    const date = new Date(d);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  async _historyRows(entityId, startDate, endDate) {
    try {
      const url = `history/period/${startDate.toISOString()}?filter_entity_id=${entityId}&end_time=${endDate.toISOString()}&minimal_response=false&no_attributes=true`;
      const data = await this._hass.callApi("GET", url);
      return (data && data[0]) || [];
    } catch (e) {
      console.warn("carte-laundry: échec de récupération de l'historique pour", entityId, e);
      return [];
    }
  }

  // ------------------------------------------------------------------
  // Lit la valeur de puissance d'une ligne d'historique. Une coupure de
  // communication (unavailable/unknown — Zigbee hors ligne, redémarrage
  // HA...) est traitée comme une conso nulle plutôt qu'ignorée, sinon
  // deux cycles séparés par une coupure se retrouvent fusionnés en un
  // seul cycle géant et faux.
  // ------------------------------------------------------------------
  _rowPowerValue(row) {
    const state = row.state ?? row.s;
    if (state === undefined || state === null) return null;
    if (state === "unavailable" || state === "unknown") return 0;
    const v = parseFloat(state);
    return isNaN(v) ? null : v;
  }

  // ------------------------------------------------------------------
  // Reconstruit l'état "en marche" au chargement de la carte, en
  // rejouant l'historique récent de la puissance (aucune entité dédiée
  // n'existe : tout est déduit de sensor.xxx_power + seuil/délai).
  // ------------------------------------------------------------------
  async _bootstrapRunningState() {
    const c = this.config;
    const start = new Date(Date.now() - 6 * 3600 * 1000); // 6h suffisent pour couvrir un cycle + son délai
    const rows = await this._historyRows(c.entity_power, start, new Date());
    const points = this._powerPointsFromRows(rows);
    const replay = this._replayPowerPoints(points);
    const stopDelayMs = (c.stop_delay_minutes ?? 4) * 60000;
    const minCycleMs = (c.min_cycle_minutes ?? 5) * 60000;

    let running = replay.running;
    let onSinceMs = replay.onSince;
    let belowSince = replay.belowSince;
    let lastCompleted = replay.cycles.length ? replay.cycles[replay.cycles.length - 1] : null;

    // Vérifie si le délai d'arrêt s'est écoulé entre la dernière donnée et maintenant
    if (running && belowSince !== null && Date.now() - belowSince >= stopDelayMs) {
      const cycleEnd = belowSince;
      if (cycleEnd - onSinceMs >= minCycleMs) {
        lastCompleted = { start: onSinceMs, end: cycleEnd };
      }
      running = false;
      onSinceMs = null;
      belowSince = null;
    }

    this._running = running;
    this._runningSince = onSinceMs !== null ? new Date(onSinceMs).toISOString() : null;
    this._belowSince = belowSince;
    this._bootstrapped = true;

    if (lastCompleted) {
      this._lastCycle = { ...lastCompleted, cost: null };
      this._computeCycleCost(lastCompleted.start, lastCompleted.end);
    }

    // Si la carte se charge alors qu'un cycle est déjà en cours, le
    // "démarrage" n'est jamais observé par _update() (il n'y a pas de
    // transition arrêt->marche à détecter) : on va donc chercher la
    // référence de coût ici, explicitement.
    if (running) {
      this._ensureCycleBaseline();
    }

    this._update();
    this._refreshPeriodStats();
  }

  // ------------------------------------------------------------------
  // Recherche du dernier cycle terminé sur une fenêtre large (7 jours),
  // indépendamment de _bootstrapRunningState qui ne regarde que les
  // dernières heures. Nécessaire car le dernier lavage peut remonter
  // à plus longtemps que ça.
  // ------------------------------------------------------------------
  async _loadLastCycle() {
    const c = this.config;
    const start = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const rows = await this._historyRows(c.entity_power, start, new Date());
    const cycles = this._extractCyclesFromPowerRows(rows);
    if (!cycles.length) return;
    const last = cycles[cycles.length - 1];

    if (!this._lastCycle || last.end > this._lastCycle.end) {
      this._lastCycle = { ...last, cost: null };
      this._computeCycleCost(last.start, last.end);
      this._update();
    }
  }

  // ------------------------------------------------------------------
  // Convertit un historique brut en liste triée de points {ts, val},
  // en traitant les coupures (unavailable/unknown) comme une conso
  // nulle plutôt que de les ignorer (sinon deux cycles séparés par une
  // coupure réseau se retrouvent fusionnés en un seul cycle géant).
  // ------------------------------------------------------------------
  _powerPointsFromRows(rows) {
    const points = [];
    for (const row of rows) {
      const val = this._rowPowerValue(row);
      const ts = row.last_changed ?? row.lu;
      if (val === null || !ts) continue;
      points.push({ ts: new Date(ts).getTime(), val });
    }
    return points;
  }

  // ------------------------------------------------------------------
  // Rejoue une liste de points de puissance avec le seuil, le délai
  // anti-pause et la durée minimale configurés, et retourne à la fois
  // les cycles terminés ET l'état final (utile pour le bootstrap, qui a
  // besoin de savoir si un cycle est encore en cours).
  //
  // Immunité au bruit : pendant le décompte d'arrêt (belowSince), une
  // remontée au-dessus du seuil n'annule ce décompte QUE si elle n'est
  // pas un pic isolé et bref — sinon un simple pic Wi-Fi ou électrique
  // de quelques secondes empêchait indéfiniment la détection d'arrêt,
  // fusionnant des cycles séparés de plusieurs heures en un seul.
  // ------------------------------------------------------------------
  _replayPowerPoints(points) {
    const c = this.config;
    const threshold = c.power_threshold ?? 8;
    const stopDelayMs = (c.stop_delay_minutes ?? 4) * 60000;
    const minCycleMs = (c.min_cycle_minutes ?? 5) * 60000;
    const noiseIgnoreMs = (c.noise_ignore_seconds ?? 45) * 1000;

    let running = false;
    let onSince = null;
    let belowSince = null;
    const cycles = [];

    for (let i = 0; i < points.length; i++) {
      const { ts, val } = points[i];
      const above = val > threshold;

      if (above) {
        if (!running) {
          running = true;
          onSince = ts;
          belowSince = null;
        } else if (belowSince !== null) {
          const next = points[i + 1];
          const isolatedBlip = next && next.val <= threshold && (next.ts - ts) < noiseIgnoreMs;
          if (!isolatedBlip) {
            belowSince = null;
          }
          // sinon : pic isolé et bref -> on l'ignore, le décompte d'arrêt continue
        }
      } else if (running) {
        if (belowSince === null) belowSince = ts;
        if (ts - belowSince >= stopDelayMs) {
          const cycleEnd = belowSince;
          if (cycleEnd - onSince >= minCycleMs) {
            cycles.push({ start: onSince, end: cycleEnd });
          }
          running = false;
          onSince = null;
          belowSince = null;
        }
      }
    }
    return { cycles, running, onSince, belowSince };
  }

  // ------------------------------------------------------------------
  // Rejoue un historique de puissance brut et retourne uniquement la
  // liste des cycles terminés (du plus ancien au plus récent). Utilisé
  // par le comptage semaine/mois (repli), la recherche du dernier
  // cycle, et la popup d'historique détaillé.
  // ------------------------------------------------------------------
  _extractCyclesFromPowerRows(rows) {
    return this._replayPowerPoints(this._powerPointsFromRows(rows)).cycles;
  }

  // ------------------------------------------------------------------
  // Machine à état "en direct" : à chaque mise à jour, on avance le
  // même algorithme seuil + délai que le bootstrap, à partir de la
  // dernière valeur connue de sensor.xxx_power.
  // ------------------------------------------------------------------
  _advanceRunningState() {
    const c = this.config;
    const threshold = c.power_threshold ?? 8;
    const stopDelayMs = (c.stop_delay_minutes ?? 4) * 60000;
    const minCycleMs = (c.min_cycle_minutes ?? 5) * 60000;
    const powerW = this._num(c.entity_power, 0);
    const now = Date.now();

    if (powerW > threshold) {
      this._belowSince = null;
      if (!this._running) {
        this._running = true;
        this._runningSince = new Date().toISOString();
      }
    } else if (this._running) {
      if (this._belowSince === null) this._belowSince = now;
      if (now - this._belowSince >= stopDelayMs) {
        const cycleEnd = this._belowSince;
        const cycleStart = new Date(this._runningSince).getTime();
        if (cycleEnd - cycleStart >= minCycleMs) {
          this._lastCycle = { start: cycleStart, end: cycleEnd, cost: null };
          this._computeCycleCost(cycleStart, cycleEnd);
        }
        this._running = false;
        this._runningSince = null;
        this._belowSince = null;
      }
    }
  }

  // ------------------------------------------------------------------
  // Coût d'un cycle défini par [startMs, endMs], à partir de
  // l'historique brut du capteur d'énergie sur cette fenêtre précise.
  // ------------------------------------------------------------------
  async _computeCycleCost(startMs, endMs) {
    const energyId = this.config.entity_energy;
    if (!energyId) return;
    const rows = await this._historyRows(energyId, new Date(startMs), new Date(endMs));
    const numeric = rows
      .map((r) => ({ v: parseFloat(r.state ?? r.s), ts: r.last_changed ?? r.lu }))
      .filter((r) => !isNaN(r.v));
    if (numeric.length < 2) return;
    const cost = Math.max(0, numeric[numeric.length - 1].v - numeric[0].v) * (this.config.price_kwh ?? 0);
    if (this._lastCycle && this._lastCycle.start === startMs && this._lastCycle.end === endMs) {
      this._lastCycle.cost = cost;
      this._update();
    }
  }

  // ------------------------------------------------------------------
  // Recalcule les stats semaine/mois EXACTEMENT de la même manière que
  // la popup d'historique : rejoue l'historique brut de la puissance
  // pour détecter les cycles, puis calcule le coût de chaque cycle
  // depuis l'historique brut du capteur d'énergie. Les statistiques
  // long terme de Home Assistant se sont révélées trop peu fiables
  // dans la pratique (calculs faux à répétition) pour être utilisées
  // ici — cette méthode garantit que "cette semaine" / "ce mois-ci"
  // correspondent toujours exactement à ce que montre la popup.
  //
  // Limite assumée : au-delà de la rétention du recorder
  // (purge_keep_days, 10 jours par défaut), les vieux cycles du mois ne
  // sont plus visibles. La semaine, elle, est toujours dans cette
  // fenêtre par défaut et reste donc fiable dans tous les cas.
  // ------------------------------------------------------------------
  async _refreshPeriodStats() {
    if (this._statsLoading) return;
    this._statsLoading = true;
    try {
      const c = this.config;
      const now = new Date();
      const weekStart = this._startOfWeek(now);
      const monthStart = this._startOfMonth(now);
      const price = c.price_kwh ?? 0;

      const [powerRows, energyRows] = await Promise.all([
        this._historyRows(c.entity_power, monthStart, now),
        c.entity_energy ? this._historyRows(c.entity_energy, monthStart, now) : Promise.resolve([]),
      ]);

      const cycles = this._extractCyclesFromPowerRows(powerRows);

      let weekCount = 0;
      let monthCount = 0;
      let weekCost = 0;
      let monthCost = 0;
      let weekHasCost = false;
      let monthHasCost = false;

      for (const cy of cycles) {
        monthCount++;
        const inWeek = cy.end >= weekStart.getTime();
        if (inWeek) weekCount++;

        if (c.entity_energy) {
          const kwh = this._energyDeltaFromRows(energyRows, cy.start, cy.end);
          if (kwh != null) {
            const cost = kwh * price;
            monthCost += cost;
            monthHasCost = true;
            if (inWeek) {
              weekCost += cost;
              weekHasCost = true;
            }
          }
        }
      }

      this._weekCount = weekCount;
      this._monthCount = monthCount;
      this._weekCost = weekHasCost ? weekCost : null;
      this._monthCost = monthHasCost ? monthCost : null;

      this._renderStats();
    } finally {
      this._statsLoading = false;
      this._lastStatsFetch = Date.now();
    }
  }

  // ------------------------------------------------------------------
  // Énergie au tout début du cycle en cours, pour afficher son coût en
  // direct — récupérée depuis l'historique récent de sensor.xxx_energy.
  // ------------------------------------------------------------------
  async _ensureCycleBaseline() {
    const energyId = this.config.entity_energy;
    if (!energyId || !this._runningSince) return;
    if (this._cycleBaselineFor === this._runningSince) return;
    const rows = await this._historyRows(energyId, new Date(this._runningSince), new Date());
    const first = rows.find((r) => {
      const s = r.state ?? r.s;
      return s !== undefined && s !== "unknown" && s !== "unavailable";
    });
    const state = first ? (first.state ?? first.s) : null;
    this._cycleBaselineEnergy = state !== null ? parseFloat(state) : this._num(energyId, null);
    this._cycleBaselineFor = this._runningSince;
  }

  _renderStats() {
    if (!this.shadowRoot) return;
    const sr = this.shadowRoot;
    sr.getElementById("cll-weekcount").textContent = this._weekCount ?? "…";
    sr.getElementById("cll-weekcost").textContent = this._weekCost != null ? this._fmtEuro(this._weekCost) : "—";
    sr.getElementById("cll-monthcount").textContent = this._monthCount ?? "…";
    sr.getElementById("cll-monthcost").textContent = this._monthCost != null ? this._fmtEuro(this._monthCost) : "—";
  }

  // ------------------------------------------------------------------
  // Énergie consommée entre deux instants, déduite d'un tableau
  // d'historique déjà chargé (évite un appel réseau par cycle) : on
  // garde la dernière valeur numérique connue avant/à chaque borne.
  // ------------------------------------------------------------------
  _energyDeltaFromRows(rows, startMs, endMs) {
    let startVal = null;
    let endVal = null;
    for (const r of rows) {
      const state = r.state ?? r.s;
      if (state === "unavailable" || state === "unknown" || state === undefined) continue;
      const v = parseFloat(state);
      if (isNaN(v)) continue;
      const ts = new Date(r.last_changed ?? r.lu).getTime();
      if (ts <= startMs) startVal = v;
      if (ts <= endMs) endVal = v;
    }
    if (startVal === null || endVal === null) return null;
    return Math.max(0, endVal - startVal);
  }

  // ------------------------------------------------------------------
  // Popup listant tous les cycles détectés sur les derniers jours
  // (history_days, 60 par défaut), du plus récent au plus ancien, avec
  // date, durée, énergie consommée et coût.
  // ------------------------------------------------------------------
  async _openHistoryDialog() {
    const sr = this.shadowRoot;
    const backdrop = sr.getElementById("cll-dialog-backdrop");
    const body = sr.getElementById("cll-dialog-body");
    backdrop.style.display = "flex";
    body.innerHTML = `<div class="cll-dialog-loading">Chargement de l'historique…</div>`;

    const c = this.config;
    const days = c.history_days || 60;
    const start = new Date(Date.now() - days * 24 * 3600 * 1000);
    const now = new Date();

    const [powerRows, energyRows] = await Promise.all([
      this._historyRows(c.entity_power, start, now),
      c.entity_energy ? this._historyRows(c.entity_energy, start, now) : Promise.resolve([]),
    ]);

    const cycles = this._extractCyclesFromPowerRows(powerRows);
    const enriched = cycles
      .map((cy) => {
        const kwh = c.entity_energy ? this._energyDeltaFromRows(energyRows, cy.start, cy.end) : null;
        const cost = kwh != null ? kwh * (c.price_kwh ?? 0) : null;
        return { ...cy, kwh, cost };
      })
      .reverse(); // du plus récent au plus ancien

    this._historyDialogCycles = enriched;
    this._renderHistoryDialog();
  }

  _renderHistoryDialog() {
    const body = this.shadowRoot.getElementById("cll-dialog-body");
    const cycles = this._historyDialogCycles || [];
    if (!cycles.length) {
      body.innerHTML = `<div class="cll-dialog-empty">Aucun cycle détecté sur cette période.</div>`;
      return;
    }
    body.innerHTML = cycles
      .map((cy) => {
        const dateStr = new Date(cy.start).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
        const timeStr = new Date(cy.start).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        const durStr = this._fmtDurationMs(cy.end - cy.start);
        const kwhStr = cy.kwh != null
          ? cy.kwh.toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + " kWh"
          : "—";
        const costStr = cy.cost != null ? this._fmtEuro(cy.cost) : "—";
        return `
          <div class="cll-cycle-row">
            <div>
              <div class="cll-cycle-date">${dateStr}, ${timeStr}</div>
              <div class="cll-cycle-sub">${durStr}</div>
            </div>
            <div class="cll-cycle-right">
              <div class="cll-cycle-cost">${costStr}</div>
              <div class="cll-cycle-kwh">${kwhStr}</div>
            </div>
          </div>`;
      })
      .join("");
  }

  _closeHistoryDialog() {
    this.shadowRoot.getElementById("cll-dialog-backdrop").style.display = "none";
  }

  _build() {
    const root = document.createElement("div");
    root.innerHTML = `
      <style>
        ha-card.cll{
          --run:#37d6c4; --run-dim:rgba(55,214,196,0.12);
          --cost:#f0a860; --led-green:#4ade80;
          background: var(--card-background-color, #1b242f);
          border-radius: var(--ha-card-border-radius, 16px);
          padding: 20px 20px 16px;
          font-family: var(--paper-font-body1_-_font-family, sans-serif);
          color: var(--primary-text-color);
          overflow:hidden;
        }
        .cll-header{ display:flex; align-items:center; justify-content:space-between; margin-bottom:18px;}
        .cll-device{ display:flex; align-items:center; gap:10px; }
        .cll-icon{ width:34px; height:34px; border-radius:9px; background: var(--secondary-background-color,#2c3947); display:flex; align-items:center; justify-content:center; flex-shrink:0;}
        .cll-icon ha-icon{ --mdc-icon-size:19px; color: var(--secondary-text-color); }
        .cll-name{ font-size:15.5px; font-weight:600; line-height:1.15; }
        .cll-sub{ font-size:11px; color: var(--secondary-text-color); margin-top:2px; }
        .cll-pill{ display:flex; align-items:center; gap:6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; padding:6px 10px 6px 8px; border-radius:100px; background: var(--secondary-background-color,#2c3947); color: var(--secondary-text-color); transition:.3s;}
        .cll-pill.on{ color: var(--run); background: var(--run-dim); }
        .cll-led{ width:7px; height:7px; border-radius:50%; background: var(--disabled-text-color,#5b6b7c); transition:.3s;}
        .cll-led.on{ background: var(--led-green); animation: cllpulse 1.8s infinite; }
        @keyframes cllpulse{ 0%{box-shadow:0 0 0 0 rgba(74,222,128,.55);} 70%{box-shadow:0 0 0 6px rgba(74,222,128,0);} 100%{box-shadow:0 0 0 0 rgba(74,222,128,0);} }

        .cll-gauge-wrap{ display:flex; flex-direction:column; align-items:center; padding:4px 0 14px; }
        .cll-porthole{ position:relative; width:150px; height:150px; border-radius:50%;
          background: radial-gradient(circle at 35% 30%, var(--secondary-background-color,#26313f), var(--card-background-color,#131a22) 75%);
          border:5px solid var(--divider-color,#29343f); overflow:hidden;
          box-shadow: inset 0 8px 20px rgba(0,0,0,.5);}
        .cll-liquid,.cll-liquid2{ position:absolute; left:50%; width:220px; height:220px; border-radius:42%; top:100%; transform:translate(-50%,0); transition: top 1.1s cubic-bezier(.4,0,.2,1), background .4s; }
        .cll-liquid{ background: var(--run); opacity:.55; }
        .cll-liquid2{ background: var(--run); opacity:.25; border-radius:45%; }
        .cll-liquid.spin{ animation: cllspin 6s linear infinite; }
        .cll-liquid2.spin{ animation: cllspin 9s linear infinite reverse; }
        @keyframes cllspin{ from{transform:translate(-50%,0) rotate(0deg);} to{transform:translate(-50%,0) rotate(360deg);} }
        .cll-liquid.glow,.cll-liquid2.glow{ border-radius:50%; animation: cllglow 2.2s ease-in-out infinite; }
        .cll-liquid2.glow{ animation-delay:.4s; }
        @keyframes cllglow{ 0%,100%{ opacity:.45; transform:translate(-50%,0) scale(1);} 50%{ opacity:.8; transform:translate(-50%,0) scale(1.08);} }
        .cll-readout{ position:relative; z-index:2; width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; }
        .cll-watt{ font-size:22px; font-weight:600; letter-spacing:-.02em; font-variant-numeric: tabular-nums; }
        .cll-watt.idle{ color: var(--secondary-text-color); }
        .cll-wattunit{ font-size:10px; color: var(--secondary-text-color); margin-top:3px; letter-spacing:.06em; }

        .cll-liverow{ display:flex; justify-content:center; gap:18px; margin-top:12px; font-size:12px; }
        .cll-liveitem{ text-align:center; }
        .cll-liveitem .lv{ color: var(--secondary-text-color); font-size:10px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px;}
        .cll-liveitem .val{ font-weight:600; font-size:12.5px; font-variant-numeric: tabular-nums; }
        .cll-liveitem .val.accent{ color: var(--run); }
        .cll-liveitem .val.cost{ color: var(--cost); }
        .cll-idlenote{ text-align:center; color: var(--secondary-text-color); font-size:12.5px; margin-top:8px; }
        .cll-lastcycle{ text-align:center; }
        .cll-lastcycle-label{ font-size:10.5px; color: var(--secondary-text-color); text-transform:uppercase; letter-spacing:.06em; margin-bottom:10px; }

        .cll-divider{ height:1px; background: var(--divider-color,#2c3947); margin:16px 0 14px; }
        .cll-stats{ display:grid; grid-template-columns:1fr 1fr; gap:10px; cursor:pointer; }
        .cll-stats:active .cll-stat{ opacity:.8; }

        .cll-dialog-backdrop{ display:none; position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:1000; align-items:center; justify-content:center; padding:20px; }
        .cll-dialog{ background: var(--card-background-color,#1b242f); border:1px solid var(--divider-color,#2c3947); border-radius:16px; width:100%; max-width:420px; max-height:78vh; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.5); font-family: var(--paper-font-body1_-_font-family, sans-serif); }
        .cll-dialog-header{ display:flex; align-items:center; justify-content:space-between; padding:16px 16px 14px 18px; border-bottom:1px solid var(--divider-color,#2c3947); flex-shrink:0; }
        .cll-dialog-title{ font-weight:600; font-size:15px; color: var(--primary-text-color); }
        .cll-dialog-close{ background:none; border:none; color: var(--secondary-text-color); font-size:15px; cursor:pointer; padding:6px 8px; line-height:1; }
        .cll-dialog-body{ overflow-y:auto; padding:8px 10px 14px; }
        .cll-dialog-loading, .cll-dialog-empty{ text-align:center; color: var(--secondary-text-color); padding:34px 10px; font-size:13px; }
        .cll-cycle-row{ display:flex; align-items:center; justify-content:space-between; padding:11px 10px; border-radius:10px; }
        .cll-cycle-row:nth-child(odd){ background: var(--secondary-background-color,#212c39); }
        .cll-cycle-date{ font-size:12.5px; font-weight:600; color: var(--primary-text-color); }
        .cll-cycle-sub{ font-size:10.5px; color: var(--secondary-text-color); margin-top:2px; }
        .cll-cycle-right{ text-align:right; }
        .cll-cycle-cost{ font-size:13px; font-weight:600; color: var(--cost); }
        .cll-cycle-kwh{ font-size:10.5px; color: var(--secondary-text-color); margin-top:2px; }
        .cll-stat{ background: var(--secondary-background-color,#212c39); border-radius:12px; padding:12px 13px; }
        .cll-stat-label{ font-size:10px; color: var(--secondary-text-color); text-transform:uppercase; letter-spacing:.06em; margin-bottom:7px;}
        .cll-stat-main{ display:flex; align-items:baseline; gap:5px; margin-bottom:3px; }
        .cll-stat-count{ font-size:19px; font-weight:600; }
        .cll-stat-countlabel{ font-size:10.5px; color: var(--secondary-text-color); }
        .cll-stat-cost{ font-size:12.5px; color: var(--cost); font-weight:600; }

        .cll-gauge-wrap.cll-idle-only{ padding: 22px 0 24px; }
      </style>
      <ha-card class="cll">
        <div class="cll-header">
          <div class="cll-device">
            <div class="cll-icon"><ha-icon id="cll-icon" icon="mdi:washing-machine"></ha-icon></div>
            <div>
              <div class="cll-name" id="cll-name"></div>
              <div class="cll-sub" id="cll-sub"></div>
            </div>
          </div>
          <div class="cll-pill" id="cll-pill">
            <div class="cll-led" id="cll-led"></div>
            <span id="cll-status">À l'arrêt</span>
          </div>
        </div>

        <div class="cll-gauge-wrap" id="cll-gaugewrap">
          <div class="cll-porthole idle" id="cll-porthole">
            <div class="cll-liquid" id="cll-liquid"></div>
            <div class="cll-liquid2" id="cll-liquid2"></div>
            <div class="cll-readout">
              <div class="cll-watt idle" id="cll-watt">0,000</div>
              <div class="cll-wattunit">KWH DU CYCLE</div>
            </div>
          </div>
          <div class="cll-liverow" id="cll-liverow" style="display:none;">
            <div class="cll-liveitem"><div class="lv">Courant</div><div class="val accent" id="cll-amp">0.0 A</div></div>
            <div class="cll-liveitem"><div class="lv">Durée</div><div class="val" id="cll-dur">00:00</div></div>
            <div class="cll-liveitem"><div class="lv">Coût cycle</div><div class="val cost" id="cll-cyclecost">0,00 €</div></div>
          </div>
          <div class="cll-lastcycle" id="cll-lastcycle" style="display:none;">
            <div class="cll-lastcycle-label">Dernier cycle</div>
            <div class="cll-liverow">
              <div class="cll-liveitem"><div class="lv">Date</div><div class="val" id="cll-lastdate">—</div></div>
              <div class="cll-liveitem"><div class="lv">Durée</div><div class="val" id="cll-lastdur">—</div></div>
              <div class="cll-liveitem"><div class="lv">Coût</div><div class="val cost" id="cll-lastcost">—</div></div>
            </div>
          </div>
          <div class="cll-idlenote" id="cll-idlenote">Aucune consommation détectée</div>
        </div>

        <div class="cll-divider"></div>

        <div class="cll-stats" id="cll-stats" title="Voir l'historique des cycles">
          <div class="cll-stat">
            <div class="cll-stat-label">Cette semaine</div>
            <div class="cll-stat-main"><span class="cll-stat-count" id="cll-weekcount">0</span><span class="cll-stat-countlabel" id="cll-weeklabel">lavages</span></div>
            <div class="cll-stat-cost" id="cll-weekcost">0,00 €</div>
          </div>
          <div class="cll-stat">
            <div class="cll-stat-label">Ce mois-ci</div>
            <div class="cll-stat-main"><span class="cll-stat-count" id="cll-monthcount">0</span><span class="cll-stat-countlabel" id="cll-monthlabel">lavages</span></div>
            <div class="cll-stat-cost" id="cll-monthcost">0,00 €</div>
          </div>
        </div>
      </ha-card>

      <div class="cll-dialog-backdrop" id="cll-dialog-backdrop">
        <div class="cll-dialog" role="dialog" aria-label="Historique des cycles">
          <div class="cll-dialog-header">
            <div class="cll-dialog-title">Historique des cycles</div>
            <button class="cll-dialog-close" id="cll-dialog-close" aria-label="Fermer">✕</button>
          </div>
          <div class="cll-dialog-body" id="cll-dialog-body">
            <div class="cll-dialog-loading">Chargement…</div>
          </div>
        </div>
      </div>
    `;
    this.attachShadow({ mode: "open" }).appendChild(root);

    const sr = this.shadowRoot;
    sr.getElementById("cll-stats").addEventListener("click", () => this._openHistoryDialog());
    sr.getElementById("cll-dialog-close").addEventListener("click", () => this._closeHistoryDialog());
    sr.getElementById("cll-dialog-backdrop").addEventListener("click", (ev) => {
      if (ev.target.id === "cll-dialog-backdrop") this._closeHistoryDialog();
    });

    this._durInterval = setInterval(() => this._updateDuration(), 1000);
  }

  _updateDuration() {
    if (!this._running || !this._runningSince) return;
    this.shadowRoot.getElementById("cll-dur").textContent = this._fmtDuration(this._runningSince);
  }

  _update() {
    if (!this._bootstrapped) return; // attend la reconstruction initiale de l'état
    const sr = this.shadowRoot;
    const c = this.config;
    const type = this._type;

    sr.getElementById("cll-name").textContent = c.name;
    sr.getElementById("cll-sub").textContent = c.subtitle || "";
    sr.getElementById("cll-icon").setAttribute("icon", type.icon);
    sr.getElementById("cll-weeklabel").textContent = type.cycleWord;
    sr.getElementById("cll-monthlabel").textContent = type.cycleWord;

    const card = sr.querySelector("ha-card.cll");
    card.style.setProperty("--run", type.accent);
    card.style.setProperty("--run-dim", type.accentDim);

    const wasRunning = this._running;
    this._advanceRunningState();
    const running = this._running;

    const pill = sr.getElementById("cll-pill");
    const led = sr.getElementById("cll-led");
    const status = sr.getElementById("cll-status");
    const porthole = sr.getElementById("cll-porthole");
    const liquid = sr.getElementById("cll-liquid");
    const liquid2 = sr.getElementById("cll-liquid2");
    const watt = sr.getElementById("cll-watt");
    const liverow = sr.getElementById("cll-liverow");
    const idlenote = sr.getElementById("cll-idlenote");
    const lastcycle = sr.getElementById("cll-lastcycle");
    const gaugeWrap = sr.getElementById("cll-gaugewrap");

    pill.classList.toggle("on", running);
    led.classList.toggle("on", running);
    status.textContent = running ? "En fonctionnement" : "À l'arrêt";

    liquid.classList.remove("spin", "glow");
    liquid2.classList.remove("spin", "glow");
    if (running) {
      liquid.classList.add(type.motion);
      liquid2.classList.add(type.motion);
    }

    porthole.style.display = running ? "flex" : "none";
    liverow.style.display = running ? "flex" : "none";
    gaugeWrap.classList.toggle("cll-idle-only", !running);

    if (!running && this._lastCycle) {
      lastcycle.style.display = "block";
      idlenote.style.display = "none";
      const lc = this._lastCycle;
      sr.getElementById("cll-lastdate").textContent = new Date(lc.start).toLocaleString("fr-FR", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
      sr.getElementById("cll-lastdur").textContent = this._fmtDurationMs(lc.end - lc.start);
      sr.getElementById("cll-lastcost").textContent = lc.cost != null ? this._fmtEuro(lc.cost) : "…";
    } else {
      lastcycle.style.display = "none";
      idlenote.style.display = running ? "none" : "block";
    }

    if (running) {
      const powerW = this._num(c.entity_power, 0);

      // Le hublot affiche la conso cumulée du cycle en cours (kWh), pas
      // la puissance instantanée — c'est ce qui permet de déduire le
      // prix du cycle. Le remous visuel, lui, reste indexé sur la
      // puissance instantanée (juste un indicateur d'intensité).
      let cycleKwh = null;
      if (c.entity_energy && this._cycleBaselineEnergy != null) {
        const currentEnergy = this._num(c.entity_energy, 0);
        cycleKwh = Math.max(0, currentEnergy - this._cycleBaselineEnergy);
        watt.textContent = cycleKwh.toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
      } else {
        watt.textContent = "…";
      }

      const pct = Math.max(0, Math.min(100, (powerW / (c.power_scale_max || 2200)) * 100));
      liquid.style.top = (100 - pct) + "%";
      liquid2.style.top = Math.min(100, 100 - pct + 4) + "%";

      if (c.entity_current) {
        sr.getElementById("cll-amp").textContent = this._num(c.entity_current, 0).toFixed(1) + " A";
      }
      this._updateDuration();

      if (!wasRunning) this._ensureCycleBaseline();

      sr.getElementById("cll-cyclecost").textContent = cycleKwh != null
        ? this._fmtEuro(cycleKwh * (c.price_kwh ?? 0))
        : "…";
    }

    if (wasRunning && !running) {
      setTimeout(() => this._refreshPeriodStats(), 15000);
    }
    if (!this._lastStatsFetch || Date.now() - this._lastStatsFetch > 5 * 60 * 1000) {
      this._lastStatsFetch = Date.now();
      this._refreshPeriodStats();
    }
    this._renderStats();
  }

  disconnectedCallback() {
    if (this._durInterval) clearInterval(this._durInterval);
  }

  static getStubConfig() {
    return {
      appliance_type: "washer",
      name: "Lave-linge",
      subtitle: "Buanderie",
      ...CLL_DEFAULTS,
      entity_power: "sensor.lave_linge_power",
      entity_current: "sensor.lave_linge_current",
      entity_energy: "sensor.lave_linge_energy",
    };
  }

  static getConfigElement() {
    return document.createElement("carte-laundry-editor");
  }
}

customElements.define("carte-laundry", CarteLaundry);

// ==========================================================================
// Éditeur graphique — configuration entièrement via l'interface Home
// Assistant (Modifier le tableau de bord > Modifier la carte). Aucun YAML
// à écrire, aucune entité à créer : seuil, délai et prix du kWh sont de
// simples valeurs saisies ici.
// ==========================================================================
const CLL_LABELS = {
  appliance_type: "Type d'appareil",
  name: "Nom de l'appareil",
  subtitle: "Sous-titre",
  entity_power: "Capteur de puissance (W)",
  entity_current: "Capteur de courant (A)",
  entity_energy: "Capteur d'énergie cumulée (kWh)",
  power_scale_max: "Échelle du hublot (W)",
  power_threshold: "Seuil de démarrage (W)",
  stop_delay_minutes: "Délai avant arrêt détecté (min)",
  min_cycle_minutes: "Durée minimale d'un cycle (min)",
  noise_ignore_seconds: "Ignorer les pics isolés plus courts que (secondes)",
  price_kwh: "Prix du kWh (€)",
  history_days: "Historique des cycles — profondeur (jours)",
};

class CarteLaundryEditor extends HTMLElement {
  setConfig(config) {
    this._config = { appliance_type: "washer", ...CLL_DEFAULTS, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  get _schema() {
    return [
      {
        name: "",
        type: "grid",
        schema: [
          {
            name: "appliance_type",
            selector: {
              select: {
                mode: "dropdown",
                options: [
                  { value: "washer", label: "Lave-linge" },
                  { value: "dryer", label: "Sèche-linge" },
                ],
              },
            },
          },
          { name: "power_scale_max", selector: { number: { mode: "box", min: 300, max: 5000, step: 50 } } },
        ],
      },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "name", selector: { text: {} } },
          { name: "subtitle", selector: { text: {} } },
        ],
      },
      { name: "entity_power", selector: { entity: { domain: "sensor" } } },
      { name: "entity_current", selector: { entity: { domain: "sensor" } } },
      { name: "entity_energy", selector: { entity: { domain: "sensor" } } },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "power_threshold", selector: { number: { mode: "box", min: 1, max: 200, step: 1 } } },
          { name: "stop_delay_minutes", selector: { number: { mode: "box", min: 0, max: 30, step: 1 } } },
        ],
      },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "min_cycle_minutes", selector: { number: { mode: "box", min: 0, max: 60, step: 1 } } },
          { name: "noise_ignore_seconds", selector: { number: { mode: "box", min: 0, max: 600, step: 5 } } },
        ],
      },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "price_kwh", selector: { number: { mode: "box", min: 0, max: 2, step: 0.0001 } } },
          { name: "history_days", selector: { number: { mode: "box", min: 7, max: 365, step: 1 } } },
        ],
      },
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
      });
      this.innerHTML = "";
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = this._schema;
    this._form.computeLabel = (s) => CLL_LABELS[s.name] || s.name;
  }
}

customElements.define("carte-laundry-editor", CarteLaundryEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "carte-laundry",
  name: "Carte Laundry",
  description: "Carte de suivi de consommation pour lave-linge ou sèche-linge connecté — sans entité à créer, tout se configure via l'interface",
});
