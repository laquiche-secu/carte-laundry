// ==========================================================================
// carte-laundry.js — Carte Lovelace personnalisée pour Home Assistant
// Fonctionne pour un lave-linge OU un sèche-linge, selon l'option
// "appliance_type" dans la configuration (design et libellés adaptés).
// ==========================================================================
// Installation :
// 1. Copiez ce fichier dans /config/www/carte-laundry.js
// 2. Paramètres > Tableaux de bord > (⋮) Ressources > Ajouter une ressource
//      URL : /local/carte-laundry.js
//      Type : Module JavaScript
// 3. Ajoutez la carte à votre tableau de bord (Ajouter une carte >
//    "Carte Laundry") : un formulaire graphique permet de tout configurer,
//    y compris le type d'appareil. lovelace-exemple.yaml reste disponible
//    si vous préférez le YAML.
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

class CarteLaundry extends HTMLElement {
  setConfig(config) {
    if (!config.entity_power || !config.entity_running) {
      throw new Error("Vous devez définir au minimum 'entity_power' et 'entity_running'.");
    }
    const applianceType = CLL_TYPES[config.appliance_type] ? config.appliance_type : "washer";
    this.config = {
      appliance_type: applianceType,
      subtitle: "",
      power_scale_max: 2200, // W — utilisé pour l'échelle du hublot
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

  // ------------------------------------------------------------------
  // Valeur du capteur d'énergie au début d'une période (semaine/mois),
  // lue dans les statistiques long terme de Home Assistant — celles-ci
  // sont conservées indéfiniment, contrairement à l'historique brut.
  // ------------------------------------------------------------------
  async _energyAtPeriodStart(startDate) {
    const energyId = this.config.entity_energy;
    if (!energyId) return null;
    try {
      const startIso = startDate.toISOString();
      const endIso = new Date(startDate.getTime() + 3 * 3600 * 1000).toISOString();
      const stats = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: startIso,
        end_time: endIso,
        statistic_ids: [energyId],
        period: "hour",
        types: ["sum"],
      });
      const rows = (stats && stats[energyId]) || [];
      const first = rows.find((r) => typeof r.sum === "number");
      return first ? first.sum : null;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Historique brut de l'état "en fonctionnement" depuis une date donnée,
  // utilisé pour compter les cycles terminés (transitions on -> off).
  // Nécessite que le recorder conserve l'historique sur toute la période
  // souhaitée (voir purge_keep_days dans configuration.yaml).
  // ------------------------------------------------------------------
  async _runningHistorySince(startDate) {
    const runId = this.config.entity_running;
    try {
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: startDate.toISOString(),
        end_time: new Date().toISOString(),
        entity_ids: [runId],
        minimal_response: false,
        no_attributes: true,
      });
      return (result && result[runId]) || [];
    } catch (e) {
      return [];
    }
  }

  _countCompletedCycles(rows, weekStart, monthStartUnusedYet) {
    const MIN_MS = 5 * 60 * 1000; // ignore les faux départs < 5 min
    let weekCount = 0;
    let monthCount = 0;
    let onSince = null;
    for (const row of rows) {
      const state = row.state ?? row.s;
      const ts = row.last_changed ?? row.lu;
      if (!ts) continue;
      if (state === "on" && onSince === null) {
        onSince = new Date(ts).getTime();
      } else if (state === "off" && onSince !== null) {
        const offTs = new Date(ts).getTime();
        if (offTs - onSince >= MIN_MS) {
          monthCount++;
          if (offTs >= weekStart.getTime()) weekCount++;
        }
        onSince = null;
      }
    }
    return { weekCount, monthCount };
  }

  // ------------------------------------------------------------------
  // Recalcule les stats semaine/mois depuis l'historique et les
  // statistiques — appelé périodiquement, jamais via des capteurs dédiés.
  // ------------------------------------------------------------------
  async _refreshPeriodStats() {
    if (this._statsLoading) return;
    this._statsLoading = true;
    try {
      const c = this.config;
      const now = new Date();
      const weekStart = this._startOfWeek(now);
      const monthStart = this._startOfMonth(now);

      const [weekBase, monthBase, runningRows] = await Promise.all([
        this._energyAtPeriodStart(weekStart),
        this._energyAtPeriodStart(monthStart),
        this._runningHistorySince(monthStart),
      ]);

      const currentEnergy = c.entity_energy ? this._num(c.entity_energy, null) : null;
      const price = c.entity_price ? this._num(c.entity_price, 0) : 0;

      this._weekCost = weekBase !== null && currentEnergy !== null
        ? Math.max(0, currentEnergy - weekBase) * price
        : null;
      this._monthCost = monthBase !== null && currentEnergy !== null
        ? Math.max(0, currentEnergy - monthBase) * price
        : null;

      const { weekCount, monthCount } = this._countCompletedCycles(runningRows, weekStart, monthStart);
      this._weekCount = weekCount;
      this._monthCount = monthCount;

      this._renderStats();
    } finally {
      this._statsLoading = false;
      this._lastStatsFetch = Date.now();
    }
  }

  // ------------------------------------------------------------------
  // Énergie au tout début du cycle en cours, pour afficher son coût en
  // direct — récupérée depuis l'historique récent (toujours disponible,
  // même avec une rétention recorder courte).
  // ------------------------------------------------------------------
  async _ensureCycleBaseline() {
    const energyId = this.config.entity_energy;
    if (!energyId || !this._runningSince) return;
    if (this._cycleBaselineFor === this._runningSince) return;
    try {
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: this._runningSince,
        end_time: new Date().toISOString(),
        entity_ids: [energyId],
        minimal_response: false,
        no_attributes: true,
      });
      const rows = (result && result[energyId]) || [];
      const first = rows.find((r) => {
        const s = r.state ?? r.s;
        return s !== undefined && s !== "unknown" && s !== "unavailable";
      });
      const state = first ? (first.state ?? first.s) : null;
      this._cycleBaselineEnergy = state !== null ? parseFloat(state) : this._num(energyId, null);
    } catch (e) {
      this._cycleBaselineEnergy = this._num(energyId, null);
    }
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
        .cll-watt{ font-size:26px; font-weight:600; letter-spacing:-.02em; font-variant-numeric: tabular-nums; }
        .cll-watt.idle{ color: var(--secondary-text-color); }
        .cll-wattunit{ font-size:10px; color: var(--secondary-text-color); margin-top:3px; letter-spacing:.06em; }

        .cll-liverow{ display:flex; justify-content:center; gap:18px; margin-top:12px; font-size:12px; }
        .cll-liveitem{ text-align:center; }
        .cll-liveitem .lv{ color: var(--secondary-text-color); font-size:10px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px;}
        .cll-liveitem .val{ font-weight:600; font-size:12.5px; font-variant-numeric: tabular-nums; }
        .cll-liveitem .val.accent{ color: var(--run); }
        .cll-liveitem .val.cost{ color: var(--cost); }
        .cll-idlenote{ text-align:center; color: var(--secondary-text-color); font-size:12.5px; margin-top:8px; }

        .cll-divider{ height:1px; background: var(--divider-color,#2c3947); margin:16px 0 14px; }
        .cll-stats{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
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
              <div class="cll-watt idle" id="cll-watt">0</div>
              <div class="cll-wattunit">WATTS</div>
            </div>
          </div>
          <div class="cll-liverow" id="cll-liverow" style="display:none;">
            <div class="cll-liveitem"><div class="lv">Courant</div><div class="val accent" id="cll-amp">0.0 A</div></div>
            <div class="cll-liveitem"><div class="lv">Durée</div><div class="val" id="cll-dur">00:00</div></div>
            <div class="cll-liveitem"><div class="lv">Coût cycle</div><div class="val cost" id="cll-cyclecost">0,00 €</div></div>
          </div>
          <div class="cll-idlenote" id="cll-idlenote">Aucune consommation détectée</div>
        </div>

        <div class="cll-divider"></div>

        <div class="cll-stats">
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
    `;
    this.attachShadow({ mode: "open" }).appendChild(root);

    this._durInterval = setInterval(() => this._updateDuration(), 1000);
  }

  _updateDuration() {
    if (!this._running || !this._runningSince) return;
    this.shadowRoot.getElementById("cll-dur").textContent = this._fmtDuration(this._runningSince);
  }

  _update() {
    const sr = this.shadowRoot;
    const c = this.config;
    const type = this._type;

    sr.getElementById("cll-name").textContent = c.name;
    sr.getElementById("cll-sub").textContent = c.subtitle || "";
    sr.getElementById("cll-icon").setAttribute("icon", type.icon);
    sr.getElementById("cll-weeklabel").textContent = type.cycleWord;
    sr.getElementById("cll-monthlabel").textContent = type.cycleWord;

    // Applique la palette et l'effet visuel propres au type d'appareil
    const card = sr.querySelector("ha-card.cll");
    card.style.setProperty("--run", type.accent);
    card.style.setProperty("--run-dim", type.accentDim);

    const runningState = this._entity(c.entity_running);
    const running = runningState && runningState.state === "on";
    const wasRunning = this._running;
    this._running = running;
    this._runningSince = runningState ? runningState.last_changed : null;

    const pill = sr.getElementById("cll-pill");
    const led = sr.getElementById("cll-led");
    const status = sr.getElementById("cll-status");
    const porthole = sr.getElementById("cll-porthole");
    const liquid = sr.getElementById("cll-liquid");
    const liquid2 = sr.getElementById("cll-liquid2");
    const watt = sr.getElementById("cll-watt");
    const liverow = sr.getElementById("cll-liverow");
    const idlenote = sr.getElementById("cll-idlenote");
    const gaugeWrap = sr.getElementById("cll-gaugewrap");

    pill.classList.toggle("on", running);
    led.classList.toggle("on", running);
    status.textContent = running ? "En fonctionnement" : "À l'arrêt";

    // Anime le hublot avec l'effet propre au type d'appareil
    // (remous d'eau pour un lave-linge, pulsation de chaleur pour un sèche-linge)
    liquid.classList.remove("spin", "glow");
    liquid2.classList.remove("spin", "glow");
    if (running) {
      liquid.classList.add(type.motion);
      liquid2.classList.add(type.motion);
    }

    // La conso en direct (hublot + courant/durée/coût) n'est affichée
    // que lorsque la machine tourne réellement.
    porthole.style.display = running ? "flex" : "none";
    liverow.style.display = running ? "flex" : "none";
    idlenote.style.display = running ? "none" : "block";
    gaugeWrap.classList.toggle("cll-idle-only", !running);

    if (running) {
      const powerW = this._num(c.entity_power, 0);
      watt.textContent = Math.round(powerW).toString();

      const pct = Math.max(0, Math.min(100, (powerW / (c.power_scale_max || 2200)) * 100));
      liquid.style.top = (100 - pct) + "%";
      liquid2.style.top = Math.min(100, 100 - pct + 4) + "%";

      if (c.entity_current) {
        sr.getElementById("cll-amp").textContent = this._num(c.entity_current, 0).toFixed(1) + " A";
      }
      this._updateDuration();

      // Un nouveau cycle vient de démarrer : on va chercher l'énergie de
      // référence dans l'historique récent (pas de capteur dédié).
      if (!wasRunning) this._ensureCycleBaseline();

      if (c.entity_energy && c.entity_price) {
        if (this._cycleBaselineEnergy != null) {
          const currentEnergy = this._num(c.entity_energy, 0);
          const price = this._num(c.entity_price, 0);
          const cost = Math.max(0, currentEnergy - this._cycleBaselineEnergy) * price;
          sr.getElementById("cll-cyclecost").textContent = this._fmtEuro(cost);
        } else {
          sr.getElementById("cll-cyclecost").textContent = "…";
        }
      }
    }

    // Un cycle vient de se terminer : les stats semaine/mois seront
    // légèrement obsolètes le temps que le recorder écrive l'historique,
    // on les rafraîchit peu après.
    if (wasRunning && !running) {
      setTimeout(() => this._refreshPeriodStats(), 15000);
    }

    // Rafraîchissement périodique des stats semaine/mois (calculées à la
    // volée depuis l'historique — aucun capteur dédié à créer).
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
      power_scale_max: 2200,
      entity_power: "sensor.lave_linge_power",
      entity_current: "sensor.lave_linge_current",
      entity_energy: "sensor.lave_linge_energy",
      entity_running: "binary_sensor.lave_linge_cycle_en_cours",
      entity_price: "input_number.prix_kwh",
    };
  }

  static getConfigElement() {
    return document.createElement("carte-laundry-editor");
  }
}

customElements.define("carte-laundry", CarteLaundry);

// ==========================================================================
// Éditeur graphique — permet de configurer la carte depuis l'interface
// Home Assistant (Modifier le tableau de bord > Modifier la carte),
// sans écrire de YAML. Inclut le choix du type d'appareil.
// ==========================================================================
const CLL_LABELS = {
  appliance_type: "Type d'appareil",
  name: "Nom de l'appareil",
  subtitle: "Sous-titre",
  power_scale_max: "Échelle du hublot (W)",
  entity_power: "Capteur de puissance (W)",
  entity_current: "Capteur de courant (A)",
  entity_energy: "Capteur d'énergie cumulée (kWh)",
  entity_running: "Capteur « cycle en cours »",
  entity_price: "Prix du kWh (calcul uniquement, non affiché)",
};

class CarteLaundryEditor extends HTMLElement {
  setConfig(config) {
    this._config = { appliance_type: "washer", ...config };
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
      { name: "entity_running", selector: { entity: { domain: "binary_sensor" } } },
      { name: "entity_price", selector: { entity: { domain: "input_number" } } },
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
  description: "Carte de suivi de consommation pour lave-linge ou sèche-linge connecté (design adapté au type d'appareil)",
});
