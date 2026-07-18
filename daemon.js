/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("ALL");

  const ARCHIVO_SCOUT = "/network/scout-report.json";

  const SCRIPT_SCOUT = "/network/scout.js";
  const SCRIPT_TACTICAL = "/network/tactical.js";
  const SCRIPT_DEPLOYER = "/network/deployer.js";

  // ==========================================================================
  // DETECCIÓN DE FLAG EN EL DAEMON
  // ==========================================================================
  // El Daemon es autónomo si se inicia sin argumentos. 
  // Si se le pasa 'true' al final, actúa como esclavo silencioso de otro proceso.
  const esEsclavo = ns.args[ns.args.length - 1] === true;

  // IMPORTANTE: Para que los scripts hijos (scout, tactical, deployer) se ejecuten
  // de manera silenciosa (esclavos), SIEMPRE debemos pasarles el flag 'true'.
  const argsHijos = [true];

  if (!esEsclavo) {
    ns.tprint("====================================================================");
    ns.tprint("😈 [NET DAEMON] - ORQUESTADOR OFENSIVO UNIFICADO V5 (MODO DAEMON)");
    ns.tprint("====================================================================");
  }

  do {
    // ==========================================================================
    // 1. EJECUCIÓN SÍNCRONA DEL SCOUT (RECONOCIMIENTO)
    // ==========================================================================
    let pidScout = ns.run(SCRIPT_SCOUT, 1, ...argsHijos);
    if (pidScout !== 0) {
      while (ns.isRunning(pidScout)) { await ns.sleep(5); }
    } else {
      ns.print(`🚨 [ERROR] No se pudo ejecutar ${SCRIPT_SCOUT}`);
      if (esEsclavo) break;
      await ns.sleep(5000);
      continue;
    }

    if (!ns.fileExists(ARCHIVO_SCOUT, "home")) {
      ns.print("⚠️ Buscando reporte de reconocimiento unificado ausente...");
      if (esEsclavo) break;
      await ns.sleep(1000);
      continue;
    }

    // ==========================================================================
    // 2. EJECUCIÓN SÍNCRONA DEL TACTICAL (PLANIFICADOR DE RECETAS)
    // ==========================================================================
    let pidTactical = ns.run(SCRIPT_TACTICAL, 1, ...argsHijos);
    if (pidTactical !== 0) {
      while (ns.isRunning(pidTactical)) { await ns.sleep(5); }
    } else {
      ns.print(`🚨 [ERROR] No se pudo ejecutar ${SCRIPT_TACTICAL}`);
      if (esEsclavo) break;
      await ns.sleep(5000);
      continue;
    }

    // Volvemos a leer el reporte unificado que ya fue procesado y actualizado por Tactical
    let datosScout = JSON.parse(ns.read(ARCHIVO_SCOUT));
    let target = datosScout.objetivo;
    let inventarioRed = datosScout.inventarioRed || [];
    let recetas = datosScout.recetasEstructurales || {};

    // ==========================================================================
    // 3. EJECUCIÓN Y ESPERA DEL DEPLOYER (LANZADOR DE HILOS)
    // ==========================================================================
    let pidDeployer = ns.run(SCRIPT_DEPLOYER, 1, ...argsHijos);
    if (pidDeployer !== 0) {
      while (ns.isRunning(pidDeployer)) { await ns.sleep(5); }
    } else {
      ns.print(`🚨 [ERROR] Falla crítica al inyectar ráfagas de hilos con ${SCRIPT_DEPLOYER}`);
    }

    // ==========================================================================
    // 4. TELEMETRÍA INTERNA INTEGRAL (Solo si el Daemon NO es esclavo)
    // ==========================================================================
    if (!esEsclavo) {
      ns.print("\n===========================================================================");
      ns.print(`📦 Red Sincronizada. Reporte del ciclo de ataque completado.`);

      let moneyMax = ns.getServerMaxMoney(target);
      let moneyCurr = ns.getServerMoneyAvailable(target);
      let secMin = ns.getServerMinSecurityLevel(target);
      let secCurr = ns.getServerSecurityLevel(target);
      let pctDinero = (moneyCurr / (moneyMax || 1));

      // Consolidamos la cantidad total de hilos activos calculados según la asignación real del JSON
      let totalH = 0; let totalWA = 0; let totalG = 0; let totalWB = 0;
      let lotesTotales = 0;

      for (const nodo of inventarioRed) {
        if (nodo.recetaAsignada !== null && recetas[nodo.recetaAsignada]) {
          const receta = recetas[nodo.recetaAsignada];
          const mult = receta.cantidad || 1;
          totalH += (receta.hack || 0) * mult;
          totalWA += (receta.weakenA || 0) * mult;
          totalG += (receta.grow || 0) * mult;
          totalWB += (receta.weakenB || 0) * mult;
          lotesTotales += mult;
        }
      }

      let txtCurr = ns.format.number(moneyCurr);
      let txtMax = ns.format.number(moneyMax);
      let txtPct = ns.format.percent(pctDinero, 1);

      ns.print(`🎯 Target: ${target.padEnd(10)} | 💰 $${txtCurr} / $${txtMax} (${txtPct})`);
      ns.print(`🛡️ Seguridad:  ${secCurr.toFixed(2)} / ${secMin.toFixed(2)} (Minimo óptimo)`);

      const rH = 1.70; const rG = 1.75; const rW = 1.75;
      let ramPorBatch = (totalH * rH) + (totalG * rG) + ((totalWA + totalWB) * rW);
      let ramRedTotal = datosScout.ramRedTotalMax || 16;

      let txtRamBatch = ns.format.ram(ramPorBatch);
      let txtRamTotal = ns.format.ram(ramRedTotal);
      let txtPctRam = ns.format.percent(ramPorBatch / (ramRedTotal || 1), 1);

      ns.print(`📊 Lotes totales inyectados: ${lotesTotales}`);
      ns.print(`📦 Hilos Globales: H:${totalH} | WA:${totalWA} | G:${totalG} | WB:${totalWB}`);
      ns.print(`🧠 Consumo RAM:    ${txtRamBatch} / ${txtRamTotal} (${txtPctRam})`);
      ns.print("===========================================================================");
    }

    // Si somos esclavos, terminamos inmediatamente tras un paso limpio
    if (esEsclavo) break;

    // Pausa prudencial para no ahogar el procesador del juego antes del siguiente ciclo
    await ns.sleep(3000);
  } while (!esEsclavo);

  if (esEsclavo) {
    ns.print("⚙️ [MASTERMIND] Daemon esclavo completado de forma síncrona.");
  }
}
