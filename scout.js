/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("ALL");

  const ARCHIVO_SALIDA = "/network/scout-report.json";

  // ==========================================================================
  // DETECCIÓN DE FLAG AL FINAL DE LOS ARGUMENTOS (BOOLEANO ESTRICTO)
  // ==========================================================================
  const esEsclavo = ns.args[ns.args.length - 1] === true;

  const miNivelHacking = ns.getHackingLevel();
  const jugador = ns.getPlayer();
  const tieneFormulas = ns.fileExists("Formulas.exe", "home");

  let servidoresConRoot = ["home"];
  let servidoresVisitados = ["home"];
  let colaEscaneo = ns.scan("home");
  let candidatosElegibles = [];

  // Variables para persistir el estado anterior de la red
  let targetAnterior = "";
  let inventarioAnteriorMap = new Map();
  let recetasAnteriores = {};

  if (ns.fileExists(ARCHIVO_SALIDA, "home")) {
    try {
      const datosPrevios = JSON.parse(ns.read(ARCHIVO_SALIDA));
      targetAnterior = datosPrevios.objetivo || "";
      recetasAnteriores = datosPrevios.recetasEstructurales || {};

      // Mapeamos el inventario previo para heredar recetas y tiempos de expiración
      if (Array.isArray(datosPrevios.inventarioRed)) {
        for (const serv of datosPrevios.inventarioRed) {
          inventarioAnteriorMap.set(serv.nombre, {
            recetaAsignada: serv.recetaAsignada || null,
            batchExpiraEn: serv.batchExpiraEn || null
          });
        }
      }
    } catch (e) { }
  }

  // ==========================================================================
  // 1. ESCANEO GLOBAL Y COMPILACIÓN DE ATACANTES (BFS)
  // ==========================================================================
  while (colaEscaneo.length > 0) {
    let servidor = colaEscaneo.shift();

    let puertosAbiertos = 0;
    if (ns.fileExists("BruteSSH.exe", "home")) { ns.brutessh(servidor); puertosAbiertos++; }
    if (ns.fileExists("FTPCrack.exe", "home")) { ns.ftpcrack(servidor); puertosAbiertos++; }
    if (ns.fileExists("relaySMTP.exe", "home")) { ns.relaysmtp(servidor); puertosAbiertos++; }
    if (ns.fileExists("HTTPWorm.exe", "home")) { ns.httpworm(servidor); puertosAbiertos++; }
    if (ns.fileExists("SQLInject.exe", "home")) { ns.sqlinject(servidor); puertosAbiertos++; }

    if (servidor === "w0r1d_d43m0n") continue;

    if (ns.getServerNumPortsRequired(servidor) <= puertosAbiertos) {
      ns.nuke(servidor);
    }

    if (servidoresVisitados.includes(servidor)) continue;
    servidoresVisitados.push(servidor);

    if (ns.hasRootAccess(servidor)) {
      servidoresConRoot.push(servidor);

      let dineroMax = ns.getServerMaxMoney(servidor);
      let nivelReq = ns.getServerRequiredHackingLevel(servidor);

      if (dineroMax > 0 && miNivelHacking >= nivelReq) {
        let pisoDineroMinimo = Math.pow(miNivelHacking, 2.5);
        if (dineroMax >= pisoDineroMinimo || servidor === "n00dles") {
          candidatosElegibles.push(servidor);
        }
      }
    }

    let vecinos = ns.scan(servidor);
    for (let vecino of vecinos) {
      if (!servidoresVisitados.includes(vecino) && !colaEscaneo.includes(vecino)) {
        colaEscaneo.push(vecino);
      }
    }
  }

  if (ns.cloud && ns.cloud.getServerNames) {
    const pservs = ns.cloud.getServerNames();
    for (const pserv of pservs) {
      if (ns.hasRootAccess(pserv) && !servidoresConRoot.includes(pserv)) {
        servidoresConRoot.push(pserv);
      }
    }
  }

  // ==========================================================================
  // MAPEADO E INVENTARIO DETALLADO DE INFRAESTRUCTURA + DOBLE CHEQUEO DE RAM
  // ==========================================================================
  let ramRedTotalMax = 0;
  let ramAtacanteMax = 0;
  let inventarioRed = [];
  const ahora = Date.now();
  let liberadosPorTimeout = 0;

  for (let serverName of servidoresConRoot) {
    if (!ns.serverExists(serverName)) continue;
    let ramMaxNode = ns.getServerMaxRam(serverName);

    if (ramMaxNode > 0) {
      if (serverName === "home") continue;
      ramRedTotalMax += ramMaxNode;

      // Recuperamos el estado previo si existía
      let recetaAsignada = null;
      let batchExpiraEn = null;

      if (inventarioAnteriorMap.has(serverName)) {
        const estadoPrevio = inventarioAnteriorMap.get(serverName);
        recetaAsignada = estadoPrevio.recetaAsignada;
        batchExpiraEn = estadoPrevio.batchExpiraEn;

        // --- NUEVO: DOBLE CHEQUEO ESTRICTO DE LIBERACIÓN ---
        // Evaluamos por tiempo, pero también verificamos la RAM real disponible del nodo
        let ramUsada = ns.getServerUsedRam(serverName);
        let tiempoExpirado = (batchExpiraEn !== null && ahora > batchExpiraEn);
        let ramCompletamenteLibre = (ramUsada === 0);

        // Si por tiempo ya debería haber terminado, forzamos la liberación SÓLO si la RAM se vació.
        // Si el tiempo pasó pero sigue habiendo RAM usada, mantenemos el bloqueo un ciclo más para proteger el flujo.
        if (tiempoExpirado) {
          if (ramCompletamenteLibre) {
            recetaAsignada = null;
            batchExpiraEn = null;
            liberadosPorTimeout++;
          } else {
            // Extendemos artificialmente la expiración un breve lapso (ej. 200ms) para reevaluar luego
            batchExpiraEn = ahora + 200;
          }
        }
      }

      inventarioRed.push({
        nombre: serverName,
        ramMax: ramMaxNode,
        ramLibre: ramMaxNode - ns.getServerUsedRam(serverName), // Mapeamos RAM libre actual para el Tactical
        recetaAsignada: recetaAsignada,
        batchExpiraEn: batchExpiraEn
      });

      if (serverName !== "home" && ramMaxNode > ramAtacanteMax) {
        ramAtacanteMax = ramMaxNode;
      }
    }
  }

  if (ramAtacanteMax === 0) {
    ramAtacanteMax = ns.getServerMaxRam("home");
  }

  inventarioRed.sort((a, b) => a.ramMax - b.ramMax);
  let listaAtacantesDepurada = inventarioRed.map(s => s.nombre);

  // ==========================================================================
  // 2. MOTOR DE EVALUACIÓN DE OBJETIVOS
  // ==========================================================================
  let rankingRentabilidad = [];

  for (let servidor of candidatosElegibles) {
    let dineroMax = ns.getServerMaxMoney(servidor);
    let dineroSecPorHilo = 0;

    if (tieneFormulas) {
      let serverStruct = ns.getServer(servidor);
      serverStruct.hackDifficulty = serverStruct.minDifficulty;
      serverStruct.moneyAvailable = dineroMax;

      let tiempoHackSeg = ns.formulas.hacking.hackTime(serverStruct, jugador) / 1000;
      let chanceExito = ns.formulas.hacking.hackChance(serverStruct, jugador);
      let porcentajeRobo = ns.formulas.hacking.hackPercent(serverStruct, jugador) / 100;
      dineroSecPorHilo = ((dineroMax * porcentajeRobo) * chanceExito) / tiempoHackSeg;
    } else {
      const seguridadMinima = ns.getServerMinSecurityLevel(servidor);
      const seguridadActual = ns.getServerSecurityLevel(servidor);
      const nivelReq = ns.getServerRequiredHackingLevel(servidor);

      let tiempoHackOptimo = ns.getHackTime(servidor) / 1000;
      if (seguridadActual > seguridadMinima) {
        tiempoHackOptimo *= (seguridadMinima / seguridadActual);
      }
      tiempoHackOptimo = Math.max(tiempoHackOptimo, 0.05);

      let chanceExitoOptima = (100 - seguridadMinima) * 0.01 * ((miNivelHacking - nivelReq + 50) / (miNivelHacking + 50));
      chanceExitoOptima = Math.min(Math.max(chanceExitoOptima, 0), 1);

      let porcentajeRoboOptimo = ns.hackAnalyze(servidor);
      let dineroActual = ns.getServerMoneyAvailable(servidor);

      if (dineroActual < dineroMax) {
        let factorSeguridadActual = (100 - seguridadActual) / 100;
        let factorSeguridadMinima = (100 - seguridadMinima) / 100;
        porcentajeRoboOptimo = (porcentajeRoboOptimo * factorSeguridadMinima) / (factorSeguridadActual || 0.01);
      }
      porcentajeRoboOptimo = Math.min(Math.max(porcentajeRoboOptimo, 0), 1);

      dineroSecPorHilo = ((dineroMax * porcentajeRoboOptimo) * chanceExitoOptima) / tiempoHackOptimo;

      if (seguridadActual > (seguridadMinima + 20)) {
        dineroSecPorHilo *= 0.1;
      }
    }

    if (miNivelHacking < 200) {
      if (servidor === "n00dles") {
        dineroSecPorHilo *= 50.0;
      } else {
        let tiempoEstimadoMin = ns.getHackTime(servidor) / 1000;
        if (tiempoEstimadoMin > 8) dineroSecPorHilo *= 0.05;
      }
    }

    if (servidor === targetAnterior) {
      dineroSecPorHilo *= 1.3;
    }

    rankingRentabilidad.push({ nombre: servidor, rendimiento: dineroSecPorHilo });
  }

  if (miNivelHacking < 80) {
    let nodoN00dles = rankingRentabilidad.find(s => s.nombre === "n00dles");
    if (nodoN00dles) nodoN00dles.rendimiento = 999999999;
  }

  rankingRentabilidad.sort((a, b) => b.rendimiento - a.rendimiento);
  let objetivoElegido = rankingRentabilidad.length > 0 ? rankingRentabilidad[0].nombre : "n00dles";

  // Distribución de payloads limpia usando la lista ordenada de menor a mayor
  for (let serverName of listaAtacantesDepurada) {
    if (serverName !== "home") {
      await ns.scp(["/shared/hack.js", "/shared/grow.js", "/shared/weaken.js"], serverName, "home");
    }
  }

  // ==========================================================================
  // EXPORTACIÓN DE DATOS CON TELEMETRÍA DE SALUD DEL OBJETIVO
  // ==========================================================================
  let datosScout = {
    objetivo: objetivoElegido,
    modoFormulas: tieneFormulas,
    ramRedTotalMax: ramRedTotalMax,
    ramAtacanteMax: ramAtacanteMax,
    listaAtacantes: listaAtacantesDepurada,
    recetasEstructurales: recetasAnteriores,
    inventarioRed: inventarioRed,
    // --- NUEVOS CAMPOS DE SALUD DINÁMICA ---
    saludObjetivo: {
      seguridadActual: ns.getServerSecurityLevel(objetivoElegido),
      seguridadMinima: ns.getServerMinSecurityLevel(objetivoElegido),
      dineroActual: ns.getServerMoneyAvailable(objetivoElegido),
      dineroMaximo: ns.getServerMaxMoney(objetivoElegido)
    }
  };

  await ns.write(ARCHIVO_SALIDA, JSON.stringify(datosScout, null, 2), "w");

  // Telemetría interna si se corre de forma manual
  if (!esEsclavo) {
    ns.tprint(`📡 [Scout] Objetivo fijado en: ${objetivoElegido}`);
    ns.tprint(`📡 [Scout] Total atacantes en la botnet: ${listaAtacantesDepurada.length}`);
    if (liberadosPorTimeout > 0) {
      ns.tprint(`📡 [Scout] Servidores liberados por haber finalizado su batch: ${liberadosPorTimeout}`);
    }
  }
}
