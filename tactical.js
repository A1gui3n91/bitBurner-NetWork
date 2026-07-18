/** @param {NS} ns **/
export async function main(ns) {
  const ARCHIVO_SCOUT = "/network/scout-report.json";

  // ==========================================================================
  // DETECCIÓN DE FLAG AL FINAL DE LOS ARGUMENTOS (BOOLEANO ESTRICTO)
  // ==========================================================================
  const esEsclavo = ns.args[ns.args.length - 1] === true;

  if (!ns.fileExists(ARCHIVO_SCOUT, "home")) {
    return;
  }

  let datosScout = JSON.parse(ns.read(ARCHIVO_SCOUT));

  let objetivo = datosScout.objetivo;
  let inventarioRed = datosScout.inventarioRed;

  if (!datosScout.recetasEstructurales) {
    datosScout.recetasEstructurales = {};
  }

  // --- NUEVO: CONSUMO DE TELEMETRÍA DE SALUD EXTRAÍDA POR EL SCOUT ---
  // Zero-RAM usage: Leemos directo del JSON en vez de ejecutar comandos ns.*
  let dineroMax = datosScout.saludObjetivo.dineroMaximo;
  let seguridadMin = datosScout.saludObjetivo.seguridadMinima;
  let seguridadReal = datosScout.saludObjetivo.seguridadActual;
  let dineroReal = datosScout.saludObjetivo.dineroActual;

  const ramHack = 1.70; const ramGrow = 1.75; const ramWeaken = 1.75;
  let asignacionesNuevas = 0;

  // Helpers y constantes para robustecer cálculos
  const MAX_GROW_THREADS = 1e6; // umbral de sanity para growthAnalyze
  const SECURITY_SLACK = 0.01; // tolerancia aceptable en cambio de seguridad neto por lote

  function safeCeil(v) { return Math.max(1, Math.ceil(v)); }

  // Unifica el modelo de crecimiento: usa ns.formulas si está disponible, si no usa exponencial
  function simulateGrowMultiplier(ns, objetivo, serverGrowthFactor, growThreads, datosScoutLocal) {
    try {
      if (datosScoutLocal.modoFormulas && typeof ns.formulas !== 'undefined' && ns.formulas.hacking && ns.formulas.hacking.growthPercent) {
        const serverPlat = ns.getServer(objetivo);
        serverPlat.hackDifficulty = serverPlat.minDifficulty;
        serverPlat.moneyAvailable = datosScoutLocal.saludObjetivo.dineroMaximo;
        // ns.formulas.hacking.growthPercent devuelve % de crecimiento por threads
        const pct = ns.formulas.hacking.growthPercent(serverPlat, ns.getPlayer(), growThreads) || 0;
        // pct is percent (e.g. 150 for 1.5x?) formulas vary; convert to multiplier safely
        const multiplier = 1 + (pct / 100);
        return multiplier;
      }
    } catch (e) {
      // fall through to empirical model
    }
    // fallback exponencial model: multiplier = exp((serverGrowthFactor/100) * threads)
    return Math.exp((serverGrowthFactor / 100) * growThreads);
  }

  // Safe growthAnalyze wrapper with cap and fallback
  function safeGrowthAnalyze(ns, objetivo, multiplier) {
    try {
      const threads = ns.growthAnalyze(objetivo, multiplier);
      if (!isFinite(threads) || threads <= 0) return null;
      if (threads > MAX_GROW_THREADS) return null;
      return Math.ceil(threads);
    } catch (e) {
      return null;
    }
  }

  // Heurística para estimar hack chance cuando no hay formulas
  function estimateHackChance(ns, objetivo) {
    try {
      if (typeof ns.formulas !== 'undefined' && ns.formulas.hacking && ns.formulas.hacking.hackChance) {
        const serverPlat = ns.getServer(objetivo);
        serverPlat.hackDifficulty = serverPlat.minDifficulty;
        serverPlat.moneyAvailable = datosScout.saludObjetivo.dineroMaximo;
        return ns.formulas.hacking.hackChance(serverPlat, ns.getPlayer()) || 0.0;
      }
    } catch (e) { }

    // Fallback heuristic similar to scout.js
    const miNivelHacking = ns.getHackingLevel();
    const seguridadMinLocal = ns.getServerMinSecurityLevel(objetivo);
    const seguridadActualLocal = ns.getServerSecurityLevel(objetivo);
    const nivelReq = ns.getServerRequiredHackingLevel(objetivo);
    let chanceExitoOptima = (100 - seguridadMinLocal) * 0.01 * ((miNivelHacking - nivelReq + 50) / (miNivelHacking + 50));
    chanceExitoOptima = Math.min(Math.max(chanceExitoOptima, 0), 1);
    return chanceExitoOptima;
  }

  // Calcula hilos weaken necesarios para mitigar un incremento de seguridad dado
  function weakenThreadsForSecurityIncrease(secIncrease) {
    return Math.max(1, Math.ceil(secIncrease / 0.05));
  }

  const serverGrowthFactor = ns.getServerGrowth(objetivo);
  const hackChanceGlobal = estimateHackChance(ns, objetivo);

  // --- NUEVO: CÁLCULO DE TIEMPOS "PLATÓNICOS" ---
  try {
    let tWeakenPerfecto = null;
    let tHackPerfecto = null;
    let tGrowPerfecto = null;

    if (datosScout.modoFormulas && typeof ns.formulas !== "undefined" && ns.formulas.hacking) {
      const serverPlat = ns.getServer(objetivo);
      serverPlat.hackDifficulty = serverPlat.minDifficulty;
      serverPlat.moneyAvailable = dineroMax;
      const player = ns.getPlayer();

      if (ns.formulas.hacking.weakenTime) tWeakenPerfecto = ns.formulas.hacking.weakenTime(serverPlat, player);
      if (ns.formulas.hacking.hackTime) tHackPerfecto = ns.formulas.hacking.hackTime(serverPlat, player);
      if (ns.formulas.hacking.growTime) tGrowPerfecto = ns.formulas.hacking.growTime(serverPlat, player);
    }

    if (tWeakenPerfecto === null) {
      const tWeakenActual = ns.getWeakenTime(objetivo);
      const ratioWeaken = Math.max(0.0001, seguridadMin / Math.max(seguridadReal, seguridadMin));
      tWeakenPerfecto = Math.max(20, Math.round(tWeakenActual * ratioWeaken));
    }
    if (tHackPerfecto === null) {
      const tHackActual = ns.getHackTime(objetivo);
      const ratioHack = Math.max(0.0001, seguridadMin / Math.max(seguridadReal, seguridadMin));
      tHackPerfecto = Math.max(20, Math.round(tHackActual * ratioHack));
    }
    if (tGrowPerfecto === null) {
      const tGrowActual = ns.getGrowTime(objetivo);
      const ratioGrow = Math.max(0.0001, seguridadMin / Math.max(seguridadReal, seguridadMin));
      tGrowPerfecto = Math.max(20, Math.round(tGrowActual * ratioGrow));
    }

    datosScout.tiemposCalculados = datosScout.tiemposCalculados || {};
    datosScout.tiemposCalculados.objetivo = objetivo;
    datosScout.tiemposCalculados.calculadoEn = Date.now();
    datosScout.tiemposCalculados.tWeakenPerfecto = tWeakenPerfecto;
    datosScout.tiemposCalculados.tHackPerfecto = tHackPerfecto;
    datosScout.tiemposCalculados.tGrowPerfecto = tGrowPerfecto;

  } catch (e) {
    ns.print(`[Tactical] Error calculando tiempos platonicos: ${e}`);
  }

  // Sumamos el impacto proyectado de los batches que ya están activos usando el MODELO UNIFICADO DE GROW
  for (let nodo of inventarioRed) {
    if (nodo.recetaAsignada !== null) {
      let receta = datosScout.recetasEstructurales[nodo.recetaAsignada];
      if (receta) {
        const cant = receta.cantidad || 1;

        // Impacto del Hack en vuelo (Resta dinero, suma seguridad)
        if (receta.hack > 0) {
          let pctPorHiloHack = ns.hackAnalyze(objetivo) || 0.002;
          let pctRoboTotal = pctPorHiloHack * receta.hack;
          // Aplicar probabilidad de éxito
          let expectedPct = pctRoboTotal * hackChanceGlobal;
          for (let c = 0; c < cant; c++) {
            dineroVirtual = Math.max(0, dineroVirtual * (1 - expectedPct));
          }
          seguridadVirtual += receta.hack * 0.002 * cant;
        }

        // Impacto del Grow en vuelo (Suma dinero, suma seguridad) - UNIFICADO
        if (receta.grow > 0) {
          let multiplier = simulateGrowMultiplier(ns, objetivo, serverGrowthFactor, receta.grow, datosScout);
          for (let c = 0; c < cant; c++) {
            dineroVirtual = Math.min(dineroMax, dineroVirtual * multiplier);
          }
          seguridadVirtual += receta.grow * 0.004 * cant;
        }

        // Impacto de los Weakens en vuelo (Bajan la seguridad)
        let weakenTotal = (receta.weakenA || 0) + (receta.weakenB || 0);
        if (weakenTotal > 0) {
          seguridadVirtual = Math.max(seguridadMin, seguridadVirtual - (weakenTotal * 0.05 * cant));
        }
      }
    }
  }

  // ==========================================================================
  // ASIGNACIÓN SECUENCIAL CON SIMULACIÓN VIRTUAL Y VALIDACIÓN DE RECETAS
  // ==========================================================================
  let nuevasRecetas = {};

  for (let nodo of inventarioRed) {
    const serverName = nodo.nombre;
    const ramMaxNode = nodo.ramMax;

    // --- Si el nodo está bloqueado por tiempo o retención de RAM, preservamos sus recetas ---
    if (nodo.recetaAsignada !== null || nodo.batchExpiraEn !== null) {
      const idWeakenPuro = `WEAKEN_PURO_${ramMaxNode}`;
      const idGrowCompuesto = `GROW_COMPUESTO_${ramMaxNode}`;
      const idCosechaHWGW = `COSECHA_HWGW_${ramMaxNode}`;

      if (datosScout.recetasEstructurales[idWeakenPuro]) nuevasRecetas[idWeakenPuro] = datosScout.recetasEstructurales[idWeakenPuro];
      if (datosScout.recetasEstructurales[idGrowCompuesto]) nuevasRecetas[idGrowCompuesto] = datosScout.recetasEstructurales[idGrowCompuesto];
      if (datosScout.recetasEstructurales[idCosechaHWGW]) nuevasRecetas[idCosechaHWGW] = datosScout.recetasEstructurales[idCosechaHWGW];

      continue;
    }

    // Reserva para home
    let ramTecho = ramMaxNode;
    if (serverName === "home") ramTecho = Math.max(0, ramMaxNode - 32);

    const ramUtil = ramTecho * 0.98;
    if (ramUtil < ramWeaken) continue;

    const idWeakenPuro = `WEAKEN_PURO_${ramMaxNode}`;
    const idGrowCompuesto = `GROW_COMPUESTO_${ramMaxNode}`;
    const idCosechaHWGW = `COSECHA_HWGW_${ramMaxNode}`;

    // =========================
    // 1) WEAKEN_PURO
    // =========================
    if (!datosScout.recetasEstructurales[idWeakenPuro]) {
      const weakenThreads = Math.floor(ramUtil / ramWeaken);
      datosScout.recetasEstructurales[idWeakenPuro] = {
        hack: 0,
        weakenA: weakenThreads,
        grow: 0,
        weakenB: 0,
        cantidad: 1,
        meta: {
          ramCost: weakenThreads * ramWeaken,
          expectedSecurityDelta: -weakenThreads * 0.05,
          sanity: 'ok'
        }
      };
    }

    // =========================
    // 2) GROW_COMPUESTO (multi-batch)
    // =========================
    if (!datosScout.recetasEstructurales[idGrowCompuesto]) {
      let hG = Math.floor(ramUtil / (ramGrow + (ramWeaken / 12.5)));
      hG = Math.max(1, hG);
      let hW = Math.max(1, Math.ceil(hG * 0.08));

      while ((hG * ramGrow + hW * ramWeaken) > ramUtil && hG > 1) {
        hG--;
        hW = Math.max(1, Math.ceil(hG * 0.08));
      }

      const costeRecetaUnitaria = (hG * ramGrow) + (hW * ramWeaken);
      let cantidad = Math.floor(ramUtil / costeRecetaUnitaria);
      if (cantidad < 1) cantidad = 1;

      // Validate grow effect using unified model and cap growthAnalyze
      let safeHG = hG;
      const multiplier = simulateGrowMultiplier(ns, objetivo, serverGrowthFactor, safeHG, datosScout);
      let expectedMoneyAfter = dineroReal * multiplier;
      let expectedSecurityDelta = safeHG * 0.004 - (hW * 0.05);

      datosScout.recetasEstructurales[idGrowCompuesto] = {
        hack: 0,
        weakenA: hW,
        grow: safeHG,
        weakenB: 0,
        cantidad: cantidad,
        meta: {
          ramCost: costeRecetaUnitaria,
          expectedMultiplier: multiplier,
          expectedSecurityDelta: expectedSecurityDelta,
          sanity: (expectedSecurityDelta <= SECURITY_SLACK) ? 'ok' : 'needs_more_weaken'
        }
      };
    }

    // =========================
    // 3) COSECHA_HWGW
    // =========================
    if (!datosScout.recetasEstructurales[idCosechaHWGW]) {
      let pctPorHiloHack = ns.hackAnalyze(objetivo) || 0.002;

      let mejorHH = 1;
      let mejorHWA = 1;
      let mejorHG = 1;
      let mejorHWB = 1;
      let mejorCantidad = 1;
      let maximaEficiencia = 0;

      const techoRoboSeguro = 0.90; // no vaciar el servidor
      const pisoRoboMinimo = 0.02;
      const ramSeguraDisponible = ramUtil * 0.98;

      // buscamos escenario por número de lotes
      for (let testCantidad = 1; testCantidad <= 32; testCantidad++) {
        let ramMaximaPorLote = ramSeguraDisponible / testCantidad;

        let tempHH = 1, tempHWA = 1, tempHG = 1, tempHWB = 1;
        let mejorPctParaEstaCantidad = 0;

        for (let testPct = techoRoboSeguro; testPct >= pisoRoboMinimo; testPct -= 0.01) {
          let hilosHack = Math.max(1, Math.floor(testPct / pctPorHiloHack));
          let hilosWeakenA = Math.ceil(hilosHack * 0.04);

          let roboRealPct = hilosHack * pctPorHiloHack;
          if (roboRealPct >= 1.0) continue;

          // threads needed to regrow
          let growThreads = safeGrowthAnalyze(ns, objetivo, 1 / (1 - roboRealPct));
          if (growThreads === null) {
            // fallback heuristic: use exponential model inverse to estimate threads
            growThreads = Math.max(1, Math.ceil(Math.log(1 / (1 - roboRealPct)) / (serverGrowthFactor / 100)));
          }
          let hilosWeakenB = Math.ceil(growThreads * 0.08);

          let costeLoteUnico = (hilosHack * ramHack) + (growThreads * ramGrow) + ((hilosWeakenA + hilosWeakenB) * ramWeaken);

          if (costeLoteUnico <= ramMaximaPorLote) {
            mejorPctParaEstaCantidad = roboRealPct;
            tempHH = hilosHack;
            tempHWA = hilosWeakenA;
            tempHG = growThreads;
            tempHWB = hilosWeakenB;
            break;
          }
        }

        if (mejorPctParaEstaCantidad > 0) {
          // compute expected yield taking into account hack chance
          const hackChanceLocal = hackChanceGlobal;
          const expectedYieldPerLote = mejorPctParaEstaCantidad * dineroMax * hackChanceLocal;
          const expectedYieldTotal = expectedYieldPerLote * testCantidad;
          const costeTotal = Math.max(1, ( (tempHH * ramHack) + (tempHG * ramGrow) + ((tempHWA + tempHWB) * ramWeaken) ) * testCantidad);
          const eficiencia = expectedYieldTotal / costeTotal;

          if (eficiencia > maximaEficiencia) {
            maximaEficiencia = eficiencia;
            mejorHH = tempHH;
            mejorHWA = tempHWA;
            mejorHG = tempHG;
            mejorHWB = tempHWB;
            mejorCantidad = testCantidad;
          }
        }
      }

      // Fallback si no se encontró escenario
      if (maximaEficiencia === 0) {
        let testPct = pisoRoboMinimo;
        let hh = Math.max(1, Math.floor(testPct / pctPorHiloHack));
        let hg = safeGrowthAnalyze(ns, objetivo, 1 / (1 - testPct));
        if (hg === null) hg = Math.max(1, Math.ceil(Math.log(1 / (1 - testPct)) / (serverGrowthFactor / 100)));
        let hwa = Math.max(1, Math.ceil(hh * 0.04));
        let hwb = Math.max(1, Math.ceil(hg * 0.08));

        // compress until fits
        while (((hh * ramHack) + (hg * ramGrow) + ((hwa + hwb) * ramWeaken)) > ramUtil) {
          if (hg > hh && hg > 1) {
            hg--;
            hwb = Math.max(1, Math.ceil(hg * 0.08));
          } else if (hh > 1) {
            hh--;
            hwa = Math.max(1, Math.ceil(hh * 0.04));
          } else break;
        }

        mejorHH = hh; mejorHG = hg; mejorHWA = hwa; mejorHWB = hwb; mejorCantidad = 1;
      }

      // Calculate meta telemetry and sanity checks
      const pctPorHiloHackFinal = ns.hackAnalyze(objetivo) || 0.002;
      const pctRoboTotalFinal = pctPorHiloHackFinal * mejorHH;
      const expectedYieldPerLoteFinal = pctRoboTotalFinal * dineroMax * hackChanceGlobal;
      const ramCostUnLoteFinal = (mejorHH * ramHack) + (mejorHG * ramGrow) + ((mejorHWA + mejorHWB) * ramWeaken);
      const expectedSecurityDeltaFinal = (mejorHH * 0.002) + (mejorHG * 0.004) - ((mejorHWA + mejorHWB) * 0.05);

      let sanity = 'ok';
      if (expectedSecurityDeltaFinal > SECURITY_SLACK) {
        // try to add weakens if RAM allows
        let extraWeakenNeeded = weakenThreadsForSecurityIncrease(expectedSecurityDeltaFinal - SECURITY_SLACK);
        let added = 0;
        while (added < extraWeakenNeeded && ((mejorHWA + mejorHWB + added + 1) * ramWeaken + mejorHH * ramHack + mejorHG * ramGrow) <= ramUtil) {
          added++;
        }
        if (added > 0) {
          // distribute added weakens to weakenB preferentially
          mejorHWB += Math.ceil(added / 2);
          mejorHWA += Math.floor(added / 2);
        }
        // recompute
        const newExpectedSecurityDelta = (mejorHH * 0.002) + (mejorHG * 0.004) - ((mejorHWA + mejorHWB) * 0.05);
        if (newExpectedSecurityDelta > SECURITY_SLACK) sanity = 'security_risk';
      }

      datosScout.recetasEstructurales[idCosechaHWGW] = {
        hack: mejorHH,
        weakenA: mejorHWA,
        grow: mejorHG,
        weakenB: mejorHWB,
        cantidad: mejorCantidad,
        meta: {
          expectedYieldPerLote: expectedYieldPerLoteFinal,
          ramCostUnLote: ramCostUnLoteFinal,
          expectedSecurityDelta: expectedSecurityDeltaFinal,
          sanity: sanity
        }
      };
    }

    // Copiamos las recetas al set de activas de este ciclo
    nuevasRecetas[idWeakenPuro] = datosScout.recetasEstructurales[idWeakenPuro];
    nuevasRecetas[idGrowCompuesto] = datosScout.recetasEstructurales[idGrowCompuesto];
    nuevasRecetas[idCosechaHWGW] = datosScout.recetasEstructurales[idCosechaHWGW];

    // ==========================================================================
    // SELECCIÓN DE RECETA Y ACTUALIZACIÓN DEL ESTADO VIRTUAL CON MULTI-BATCH
    // ==========================================================================
    let recetaElegida = "";

    if (seguridadVirtual > seguridadMin + 1) {
      recetaElegida = idWeakenPuro;
      let receta = datosScout.recetasEstructurales[idWeakenPuro];
      const cant = receta.cantidad || 1;

      seguridadVirtual = Math.max(seguridadMin, seguridadVirtual - (receta.weakenA * 0.05 * cant));

    } else if (dineroVirtual < dineroMax * 0.95) {
      recetaElegida = idGrowCompuesto;
      let receta = datosScout.recetasEstructurales[idGrowCompuesto];
      const cant = receta.cantidad || 1;

      // Usamos el modelo UNIFICADO para calcular el efecto del grow
      let multiplier = simulateGrowMultiplier(ns, objetivo, serverGrowthFactor, receta.grow, datosScout);
      for (let c = 0; c < cant; c++) {
        dineroVirtual = Math.min(dineroMax, dineroVirtual * multiplier);
      }
      seguridadVirtual = Math.max(seguridadMin, seguridadVirtual + (receta.grow * 0.004 * cant) - (receta.weakenA * 0.05 * cant));

    } else {
      recetaElegida = idCosechaHWGW;
      let receta = datosScout.recetasEstructurales[idCosechaHWGW];
      const cant = receta.cantidad || 1;

      let pctPorHiloHack = ns.hackAnalyze(objetivo) || 0.002;
      let pctRoboTotal = pctPorHiloHack * receta.hack;
      // aplicamos hackChance a la expectativa
      let expectedPct = pctRoboTotal * hackChanceGlobal;

      for (let c = 0; c < cant; c++) {
        dineroVirtual = Math.max(0, dineroVirtual * (1 - expectedPct));
      }

      // efecto de grow con modelo unificado
      let multiplier = simulateGrowMultiplier(ns, objetivo, serverGrowthFactor, receta.grow, datosScout);
      for (let c = 0; c < cant; c++) {
        dineroVirtual = Math.min(dineroMax, dineroVirtual * multiplier);
      }

      seguridadVirtual = Math.max(
        seguridadMin,
        seguridadVirtual + (receta.hack * 0.002 * cant) + (receta.grow * 0.004 * cant) - ((receta.weakenA + receta.weakenB) * 0.05 * cant)
      );
    }

    nodo.recetaAsignada = recetaElegida;
    asignacionesNuevas++;
  }

  // ==========================================================================
  // GUARDADO DE DATOS
  // ==========================================================================
  datosScout.recetasEstructurales = nuevasRecetas;
  await ns.write(ARCHIVO_SCOUT, JSON.stringify(datosScout, null, 2), "w");

  if (!esEsclavo) {
    ns.tprint(`⚙️ [Tactical] Planificación completada para: ${objetivo}`);
    ns.tprint(`⚙️ [Tactical] Servidores recién asignados: ${asignacionesNuevas}`);
    ns.tprint(`⚙️ [Tactical] Proyección final -> Seg Virtual: ${seguridadVirtual.toFixed(2)} | Din Virtual: $${ns.format.number(dineroVirtual)}`);
  }
}
