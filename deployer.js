/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("ALL");

  const ARCHIVO_SCOUT = "/network/scout-report.json";
  const DELAY_ENTRE_HILOS = 200; // Espaciado base (WA -> H -> G -> WB)

  // Duración exacta de un lote atómico (4 acciones espaciadas por el delay)
  const DURACION_LOTE = DELAY_ENTRE_HILOS * 4;

  const esEsclavo = ns.args[ns.args.length - 1] === true;

  if (!ns.fileExists(ARCHIVO_SCOUT, "home")) {
    if (!esEsclavo) ns.tprint("❌ ERROR: No se encontró el reporte unificado del scout.");
    return;
  }

  const datosScout = JSON.parse(ns.read(ARCHIVO_SCOUT));
  const objetivo = datosScout.objetivo;
  const inventarioRed = datosScout.inventarioRed;
  const recetas = datosScout.recetasEstructurales;

  if (!objetivo || !inventarioRed || !recetas) {
    if (!esEsclavo) ns.tprint("❌ ERROR: El archivo scout no contiene la estructura esperada.");
    return;
  }

  const ramHack = 1.70;
  const ramGrow = 1.75;
  const ramWeaken = 1.75;
  const scriptsRequeridos = ["/shared/hack.js", "/shared/grow.js", "/shared/weaken.js"];
  let ataquesInyectados = 0;

  // 1. Contar servidores válidos para el pipeline global
  const nodosActivos = inventarioRed.filter(nodo => {
    if (nodo.recetaAsignada === null) return false;
    if (nodo.batchExpiraEn && Date.now() < nodo.batchExpiraEn) return false;

    const receta = recetas[nodo.recetaAsignada];
    if (!receta) return false;
    if (receta.hack === 0 && receta.grow === 0 && receta.weakenA === 0 && receta.weakenB === 0) return false;

    return ns.serverExists(nodo.nombre) && ns.hasRootAccess(nodo.nombre);
  });

  const cantidadServidoresActivos = nodosActivos.length;

  if (cantidadServidoresActivos === 0) {
    if (!esEsclavo) ns.print("🕊️ No hay servidores listos para desplegar en este ciclo.");
    return;
  }

  // Tiempos base del objetivo
  const tHack = ns.getHackTime(objetivo);
  const tGrow = ns.getGrowTime(objetivo);
  const tWeaken = ns.getWeakenTime(objetivo);
  const tiempoFinalBase = tWeaken;

  // 2. PIPELINE GLOBAL: Intervalo dinámico máximo asignado a cada servidor
  const intervaloServidoresDinamico = Math.floor(tiempoFinalBase / cantidadServidoresActivos);

  const marcaTiempoBase = Date.now();
  let retrasoAcumuladoPorServidor = 0;

  // 3. Despliegue e inyección con control de colapso interno
  for (let nodo of nodosActivos) {
    const hostAtacante = nodo.nombre;
    const idReceta = nodo.recetaAsignada;
    const receta = recetas[idReceta];

    // Verificar scripts
    let scriptsListos = true;
    for (let script of scriptsRequeridos) {
      if (!ns.fileExists(script, hostAtacante)) {
        if (hostAtacante !== "home") {
          scriptsListos = await ns.scp(script, hostAtacante, "home");
        } else {
          scriptsListos = false;
        }
        if (!scriptsListos) break;
      }
    }
    if (!scriptsListos) continue;

    // --- MATEMÁTICA INTERNA DINÁMICA DEL SERVIDOR ---
    let cantidadLotesTeorica = receta.cantidad || 1;

    // Control de seguridad: La ráfaga de este servidor no puede invadir el tiempo del siguiente
    const maxLotesPermitidosPorPipeline = Math.floor(intervaloServidoresDinamico / DURACION_LOTE);

    // Elegimos el limitante más estricto (receta pedida vs espacio real en el pipeline)
    let cantidadLotesReales = Math.min(cantidadLotesTeorica, maxLotesPermitidosPorPipeline);

    if (cantidadLotesReales === 0) {
      // El pipeline está tan ajustado o la cantidad de servidores es tan alta que no entra ni 1 lote completo
      // Forzamos 1 para no apagar el servidor, pero idealmente achicamos la red o t_weaken es muy bajo.
      cantidadLotesReales = 1;
    }

    // Control de RAM basado en los lotes reales recalculados
    const costoRAMUnLote = (receta.hack * ramHack) + (receta.weakenA * ramWeaken) + (receta.grow * ramGrow) + (receta.weakenB * ramWeaken);
    let costoRAMTotal = costoRAMUnLote * cantidadLotesReales;

    const ramMax = ns.getServerMaxRam(hostAtacante);
    const ramUtilizada = ns.getServerUsedRam(hostAtacante);
    let ramLibre = ramMax - ramUtilizada;

    // Si no da la RAM, bajamos la cantidad de lotes progresivamente en lugar de cancelar todo
    while (ramLibre < costoRAMTotal && cantidadLotesReales > 1) {
      cantidadLotesReales--;
      costoRAMTotal = costoRAMUnLote * cantidadLotesReales;
    }

    if (ramLibre < costoRAMTotal) {
      nodo.recetaAsignada = null;
      continue;
    }

    let lotesInyectadosEnEsteNodo = 0;
    let maxTiempoExpiracionNodo = 0;

    // Ejecución de los lotes
    for (let i = 0; i < cantidadLotesReales; i++) {
      // DELAY DINÁMICO INTERNO: Cada lote se desplaza exactamente el equivalente a la duración del anterior
      // DELAY GLOBAL: Se le suma el retraso acumulado del servidor en la red.
      const offsetTemporalBatch = (i * DURACION_LOTE) + retrasoAcumuladoPorServidor;

      const delayHack = tiempoFinalBase - tHack - DELAY_ENTRE_HILOS + offsetTemporalBatch;
      const delayWeakenA = tiempoFinalBase - tWeaken + offsetTemporalBatch;
      const delayGrow = tiempoFinalBase - tGrow + DELAY_ENTRE_HILOS + offsetTemporalBatch;
      const delayWeakenB = tiempoFinalBase - tWeaken + (DELAY_ENTRE_HILOS * 2) + offsetTemporalBatch;

      if (delayHack < 0 || delayWeakenA < 0 || delayGrow < 0 || delayWeakenB < 0) {
        break;
      }

      const idBucle = `${marcaTiempoBase}_L${i}_${Math.random().toString(36).substring(2, 5)}`;
      let inyeccionLoteExitosa = true;

      if (receta.weakenA > 0) {
        let pid = ns.exec("/shared/weaken.js", hostAtacante, receta.weakenA, objetivo, delayWeakenA, `WA_${idBucle}`);
        if (pid === 0) inyeccionLoteExitosa = false;
      }
      if (receta.hack > 0 && inyeccionLoteExitosa) {
        let pid = ns.exec("/shared/hack.js", hostAtacante, receta.hack, objetivo, delayHack, `H_${idBucle}`);
        if (pid === 0) inyeccionLoteExitosa = false;
      }
      if (receta.grow > 0 && inyeccionLoteExitosa) {
        let pid = ns.exec("/shared/grow.js", hostAtacante, receta.grow, objetivo, delayGrow, `G_${idBucle}`);
        if (pid === 0) inyeccionLoteExitosa = false;
      }
      if (receta.weakenB > 0 && inyeccionLoteExitosa) {
        let pid = ns.exec("/shared/weaken.js", hostAtacante, receta.weakenB, objetivo, delayWeakenB, `WB_${idBucle}`);
        if (pid === 0) inyeccionLoteExitosa = false;
      }

      if (inyeccionLoteExitosa) {
        lotesInyectadosEnEsteNodo++;
        const expiracionLoteAbsoluta = marcaTiempoBase + tiempoFinalBase + offsetTemporalBatch + (DELAY_ENTRE_HILOS * 3);
        if (expiracionLoteAbsoluta > maxTiempoExpiracionNodo) {
          maxTiempoExpiracionNodo = expiracionLoteAbsoluta;
        }
      } else {
        break;
      }
    }

    if (lotesInyectadosEnEsteNodo > 0) {
      nodo.batchExpiraEn = maxTiempoExpiracionNodo;
      ataquesInyectados += lotesInyectadosEnEsteNodo;

      // Avanzamos el pipeline global para el próximo servidor
      retrasoAcumuladoPorServidor += intervaloServidoresDinamico;
    } else {
      nodo.recetaAsignada = null;
    }
  }

  await ns.write(ARCHIVO_SCOUT, JSON.stringify(datosScout, null, 2), "w");

  if (!esEsclavo) {
    ns.tprint(`🚀 [Deployer] Pipeline Protegido. Servidores: ${cantidadServidoresActivos} | Lote: ${DURACION_LOTE}ms | Inyectados: ${ataquesInyectados}`);
  }
}
