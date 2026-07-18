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

  // ==========================================================================
  // INICIALIZACIÓN DEL ESTADO VIRTUAL DE LA RED (IN-FLIGHT)
  // ==========================================================================
  let seguridadVirtual = seguridadReal;
  let dineroVirtual = dineroReal;

  const serverGrowthFactor = ns.getServerGrowth(objetivo);

  // --- NUEVO: CÁLCULO DE TIEMPOS "PLATÓNICOS" ---
  // Tactical ahora calcula los tiempos ideales (cuando el objetivo está en seguridad mínima)
  // y los publica en datosScout.tiemposCalculados para que el Deployer los use como fuente
  // de verdad en lugar de recalcular en vuelo.
  try {
    let tWeakenPerfecto = null;
    let tHackPerfecto = null;
    let tGrowPerfecto = null;

    if (datosScout.modoFormulas && typeof ns.formulas !== "undefined" && ns.formulas.hacking) {
      // Usamos las fórmulas oficiales forzando el estado "platonico" del servidor
      const serverPlat = ns.getServer(objetivo);
      serverPlat.hackDifficulty = serverPlat.minDifficulty;
      serverPlat.moneyAvailable = dineroMax;
      const player = ns.getPlayer();

      // ns.formulas.hacking.* devuelve tiempos en ms
      if (ns.formulas.hacking.weakenTime) {
        tWeakenPerfecto = ns.formulas.hacking.weakenTime(serverPlat, player);
      }
      if (ns.formulas.hacking.hackTime) {
        tHackPerfecto = ns.formulas.hacking.hackTime(serverPlat, player);
      }
      if (ns.formulas.hacking.growTime) {
        tGrowPerfecto = ns.formulas.hacking.growTime(serverPlat, player);
      }
    }

    // Fallback empírico: ajustamos el tiempo actual según la proporción entre seguridad mínima y actual
    if (tWeakenPerfecto === null) {
      const tWeakenActual = ns.getWeakenTime(objetivo);
      // Evitamos división por cero y forzamos que el perfecto nunca sea mayor al actual por accidente
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

    // Publicamos los tiempos calculados para que el Deployer los consuma como fuente única
    datosScout.tiemposCalculados = datosScout.tiemposCalculados || {};
    datosScout.tiemposCalculados.objetivo = objetivo;
    datosScout.tiemposCalculados.calculadoEn = Date.now();
    datosScout.tiemposCalculados.tWeakenPerfecto = tWeakenPerfecto;
    datosScout.tiemposCalculados.tHackPerfecto = tHackPerfecto;
    datosScout.tiemposCalculados.tGrowPerfecto = tGrowPerfecto;

  } catch (e) {
    // En caso de error, no rompemos la planificación — simplemente no exponemos tiemposCalculados
    ns.print(`[Tactical] Error calculando tiempos platonicos: ${e}`);
  }

  // Sumamos el impacto proyectado de los batches que ya están activos
  for (let nodo of inventarioRed) {
    if (nodo.recetaAsignada !== null) {
      let receta = datosScout.recetasEstructurales[nodo.recetaAsignada];
      if (receta) {
        const cant = receta.cantidad || 1;

        // Impacto del Hack en vuelo (Resta dinero, suma seguridad)
        if (receta.hack > 0) {
          let pctPorHiloHack = ns.hackAnalyze(objetivo) || 0.002;
          let pctRoboTotal = pctPorHiloHack * receta.hack;
          for (let c = 0; c < cant; c++) {
            dineroVirtual = Math.max(0, dineroVirtual * (1 - pctRoboTotal));
          }
          seguridadVirtual += receta.hack * 0.002 * cant;
        }

        // Impacto del Grow en vuelo (Suma dinero, suma seguridad)
        if (receta.grow > 0) {
          // Ajuste elástico del factor de crecimiento usando el multiplicador base del juego
          let factorCrecimiento = 1 + ((serverGrowthFactor / 100) * receta.grow);
          for (let c = 0; c < cant; c++) {
            dineroVirtual = Math.min(dineroMax, dineroVirtual * factorCrecimiento);
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
  // ASIGNACIÓN SECUENCIAL CON SIMULACIÓN VIRTUAL
  // ==========================================================================
  let nuevasRecetas = {};

  for (let nodo of inventarioRed) {
    const serverName = nodo.nombre;
    const ramMaxNode = nodo.ramMax;

    // --- MEJORA SCOUT EN ALINEACIÓN CON EL NUEVO DOBLE CHEQUEO ---
    // Si el nodo está bloqueado por tiempo o retención de RAM, preservamos sus recetas
    if (nodo.recetaAsignada !== null || nodo.batchExpiraEn !== null) {

      const idWeakenPuro = `WEAKEN_PURO_${ramMaxNode}`;
      const idGrowCompuesto = `GROW_COMPUESTO_${ramMaxNode}`;
      const idCosechaHWGW = `COSECHA_HWGW_${ramMaxNode}`;

      if (datosScout.recetasEstructurales[idWeakenPuro]) {
        nuevasRecetas[idWeakenPuro] = datosScout.recetasEstructurales[idWeakenPuro];
      }
      if (datosScout.recetasEstructurales[idGrowCompuesto]) {
        nuevasRecetas[idGrowCompuesto] = datosScout.recetasEstructurales[idGrowCompuesto];
      }
      if (datosScout.recetasEstructurales[idCosechaHWGW]) {
        nuevasRecetas[idCosechaHWGW] = datosScout.recetasEstructurales[idCosechaHWGW];
      }

      continue;
    }

    // Filtro de reserva para Home
    let ramTecho = ramMaxNode;
    if (serverName === "home") {
      ramTecho = Math.max(0, ramMaxNode - 32);
    }

    const ramUtil = ramTecho * 0.98;
    if (ramUtil < ramWeaken) continue;

    const idWeakenPuro = `WEAKEN_PURO_${ramMaxNode}`;
    const idGrowCompuesto = `GROW_COMPUESTO_${ramMaxNode}`;
    const idCosechaHWGW = `COSECHA_HWGW_${ramMaxNode}`;

    // ==========================================================================
    // 1. Generar receta WEAKEN_PURO
    // ==========================================================================
    if (!datosScout.recetasEstructurales[idWeakenPuro]) {
      datosScout.recetasEstructurales[idWeakenPuro] = {
        hack: 0,
        weakenA: Math.floor(ramUtil / ramWeaken),
        grow: 0,
        weakenB: 0,
        cantidad: 1
      };
    }

    // ==========================================================================
    // 2. Generar receta GROW_COMPUESTO (Multi-batch adaptativo)
    // ==========================================================================
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

      datosScout.recetasEstructurales[idGrowCompuesto] = {
        hack: 0,
        weakenA: hW,
        grow: hG,
        weakenB: 0,
        cantidad: cantidad
      };
    }

    // ==========================================================================
    // 3. Generar receta COSECHA_HWGW (Optimización Top-Down por Lotes Enteros Masivos)
    // ==========================================================================
    if (!datosScout.recetasEstructurales[idCosechaHWGW]) {
      let pctPorHiloHack = ns.hackAnalyze(objetivo) || 0.002;

      let mejorHH = 1;
      let mejorHWA = 1;
      let mejorHG = 1;
      let mejorHWB = 1;
      let mejorCantidad = 1;
      let maximaEficiencia = 0;

      const techoRoboSeguro = 0.90; // Límite físico de seguridad para no vaciar el servidor
      const pisoRoboMinimo = 0.02;  // No nos interesa bajar de un 2% por lote

      // Margen de seguridad para la RAM del host (98% de la RAM disponible)
      const ramSeguraDisponible = ramUtil * 0.98;

      // Evaluamos escenarios: ¿Qué pasa si intentamos meter 1 lote masivo, 2 lotes, 3 lotes... hasta un límite lógico?
      // Esto evita el cuello de botella de generar cientos de micro-lotes.
      for (let testCantidad = 1; testCantidad <= 32; testCantidad++) {

        // Calculamos cuánta RAM tiene permitida gastar UN SOLO lote en este escenario de "N" lotes
        let ramMaximaPorLote = ramSeguraDisponible / testCantidad;

        // Búsqueda binaria o refinamiento lineal inverso para encontrar el % de robo óptimo para esa porción de RAM
        let mejorPctParaEstaCantidad = 0;
        let tempHH = 1, tempHWA = 1, tempHG = 1, tempHWB = 1;

        // Iteramos de forma descendente desde el techo seguro para maximizar la agresividad
        for (let testPct = techoRoboSeguro; testPct >= pisoRoboMinimo; testPct -= 0.01) {
          let hilosHack = Math.max(1, Math.floor(testPct / pctPorHiloHack));
          let hilosWeakenA = Math.ceil(hilosHack * 0.04);

          // Calculamos crecimiento basándonos en el porcentaje exacto que esos hilos van a robar en la realidad
          let roboRealPct = hilosHack * pctPorHiloHack;
          if (roboRealPct >= 1.0) continue; // Seguridad matemática elemental

          let hilosGrow = Math.ceil(ns.growthAnalyze(objetivo, 1 / (1 - roboRealPct)));
          let hilosWeakenB = Math.ceil(hilosGrow * 0.08);

          let costeLoteUnico = (hilosHack * ramHack) + (hilosGrow * ramGrow) + ((hilosWeakenA + hilosWeakenB) * ramWeaken);

          // Si el lote perfecto balanceado cabe en la porción de RAM asignada, encontramos el techo para esta cantidad
          if (costeLoteUnico <= ramMaximaPorLote) {
            mejorPctParaEstaCantidad = roboRealPct;
            tempHH = hilosHack;
            tempHWA = hilosWeakenA;
            tempHG = hilosGrow;
            tempHWB = hilosWeakenB;
            break; // Salimos del bucle de % porque este es el más alto (agresivo) que cabe en esta división
          }
        }

        // Si encontramos un porcentaje válido para esta cantidad de lotes, medimos su retorno total
        if (mejorPctParaEstaCantidad > 0) {
          // Eficiencia real de la ráfaga completa: % de robo por lote * cantidad de lotes enteros
          let eficienciaRetorno = mejorPctParaEstaCantidad * testCantidad;

          // Preferimos este escenario si excede la eficiencia máxima encontrada
          if (eficienciaRetorno > maximaEficiencia) {
            maximaEficiencia = eficienciaRetorno;
            mejorHH = tempHH;
            mejorHWA = tempHWA;
            mejorHG = tempHG;
            mejorHWB = tempHWB;
            mejorCantidad = testCantidad;
          }
        }
      }

      // Fallback de emergencia: Si la RAM es tan diminuta que no entra ni un lote del 2%
      if (maximaEficiencia === 0) {
        let testPct = pisoRoboMinimo;
        mejorHH = Math.max(1, Math.floor(testPct / pctPorHiloHack));
        mejorHG = Math.max(1, Math.ceil(ns.growthAnalyze(objetivo, 1 / (1 - testPct))));
        mejorHWA = Math.max(1, Math.ceil(mejorHH * 0.04));
        mejorHWB = Math.max(1, Math.ceil(mejorHG * 0.08));
        mejorCantidad = 1;

        // Compresión agresiva de hilos por fuerza bruta si desborda la RAM del nodo
        while (((mejorHH * ramHack) + (mejorHG * ramGrow) + ((mejorHWA + mejorHWB) * ramWeaken)) > ramUtil) {
          if (mejorHG > mejorHH && mejorHG > 1) {
            mejorHG--;
            mejorHWB = Math.max(1, Math.ceil(mejorHG * 0.08));
          } else if (mejorHH > 1) {
            mejorHH--;
            mejorHWA = Math.max(1, Math.ceil(mejorHH * 0.04));
          } else {
            break;
          }
        }
      }

      datosScout.recetasEstructurales[idCosechaHWGW] = {
        hack: mejorHH,
        weakenA: mejorHWA,
        grow: mejorHG,
        weakenB: mejorHWB,
        cantidad: mejorCantidad
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

      // Reemplazo para el cálculo real de crecimiento exponencial
      let factorCrecimiento = Math.exp((serverGrowthFactor / 100) * receta.grow);
      for (let c = 0; c < cant; c++) {
        dineroVirtual = Math.min(dineroMax, dineroVirtual * factorCrecimiento);
      }
      seguridadVirtual = Math.max(seguridadMin, seguridadVirtual + (receta.grow * 0.004 * cant) - (receta.weakenA * 0.05 * cant));

    } else {
      recetaElegida = idCosechaHWGW;
      let receta = datosScout.recetasEstructurales[idCosechaHWGW];
      const cant = receta.cantidad || 1;

      let pctPorHiloHack = ns.hackAnalyze(objetivo) || 0.002;
      let pctRoboTotal = pctPorHiloHack * receta.hack;

      for (let c = 0; c < cant; c++) {
        dineroVirtual = Math.max(0, dineroVirtual * (1 - pctRoboTotal));
      }

      // Reemplazo para el cálculo real de crecimiento exponencial
      let factorCrecimiento = Math.exp((serverGrowthFactor / 100) * receta.grow);
      for (let c = 0; c < cant; c++) {
        dineroVirtual = Math.min(dineroMax, dineroVirtual * factorCrecimiento);
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
