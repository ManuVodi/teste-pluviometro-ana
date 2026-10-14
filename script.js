const form = document.getElementById("consultaForm");
const codigoInput = document.getElementById("codigo");
const inicioInput = document.getElementById("inicio");
const fimInput = document.getElementById("fim");
const consultarBtn = document.getElementById("consultarBtn");
const csvBtn = document.getElementById("csvBtn");
const statusBox = document.getElementById("status");
const tbody = document.getElementById("linhas");
const contador = document.getElementById("contador");

let resultados = [];

// O endpoint legado pode não estar mais disponível.
// Configure aqui uma URL de API que permita acesso direto do navegador (CORS).
const API_URL = "https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos";

function setStatus(message, type = "info") {
  statusBox.textContent = message;
  statusBox.className = `status status-${type}`;
}

function toBrazilDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldValue(record, aliases) {
  const names = new Set(aliases.map(normalized));
  const nodes = [record, ...record.querySelectorAll("*")];
  for (const node of nodes) {
    if (names.has(normalized(node.localName || node.nodeName)) && node.textContent.trim()) {
      return node.textContent.trim();
    }
  }
  return "";
}

function separateDateAndTime(dateText, timeText = "") {
  let data = (dateText || "").trim();
  let hora = (timeText || "").trim();

  if (data && !hora) {
    let match = data.match(/^(.+?)[T ](\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (!match) {
      match = data.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
    }
    if (match) {
      data = match[1].trim();
      hora = match[2].trim();
    }
  }

  if (/^\d{4}$/.test(hora)) hora = `${hora.slice(0, 2)}:${hora.slice(2)}`;
  if (/^\d{6}$/.test(hora)) hora = `${hora.slice(0, 2)}:${hora.slice(2, 4)}:${hora.slice(4)}`;
  return { data, hora };
}

function parseAnaXml(xmlText, stationCode) {
  let doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("A API retornou um XML inválido.");

  // Algumas respostas SOAP encapsulam o XML real como texto.
  const resultNode = [...doc.getElementsByTagName("*")]
    .find(node => normalized(node.localName || node.nodeName) === "dadoshidrometeorologicosresult");

  if (resultNode && resultNode.textContent.trim().startsWith("<")) {
    const nested = new DOMParser().parseFromString(resultNode.textContent.trim(), "application/xml");
    if (!nested.querySelector("parsererror")) doc = nested;
  }

  const dateNames = new Set(["data", "dataleitura", "datahora", "datamedicao", "datacoleta",
    "datahoraleitura", "datahoramedicao"].map(normalized));
  const valueNames = new Set(["valor", "chuva", "precipitacao", "precipitacaomm",
    "valorchuva", "chuvaemmm", "precipitacaoobservada"].map(normalized));

  const allNodes = [...doc.getElementsByTagName("*")];
  const candidates = allNodes.filter(node => {
    const names = [...node.children].map(child => normalized(child.localName || child.nodeName));
    return names.some(name => dateNames.has(name) || valueNames.has(name));
  });
  const candidateSet = new Set(candidates);
  const rows = candidates.filter(node =>
    ![...node.children].some(child =>
      [child, ...child.querySelectorAll("*")].some(descendant => candidateSet.has(descendant))
    )
  );

  const parsed = rows.map(node => {
    const rawDate = fieldValue(node, ["data", "dataLeitura", "dataMedicao", "dataColeta",
      "dataHora", "dataHoraLeitura", "dataHoraMedicao"]);
    const rawTime = fieldValue(node, ["hora", "horaLeitura", "horaMedicao", "horario"]);
    const { data, hora } = separateDateAndTime(rawDate, rawTime);

    return {
      codigo: fieldValue(node, ["codEstacao", "codigoEstacao", "estacao"]) || stationCode,
      data,
      hora,
      chuva: fieldValue(node, ["chuva", "precipitacao", "precipitacaoMm", "valorChuva",
        "valor", "chuvaMm", "precipitacaoObservada"])
    };
  }).filter(row => row.data || row.chuva);

  const unique = new Map();
  for (const row of parsed) {
    unique.set([row.codigo, row.data, row.hora, row.chuva].join("|"), row);
  }
  return [...unique.values()];
}

function renderResults(rows) {
  tbody.replaceChildren();

  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = 4;
    td.innerHTML = '<span class="empty-icon">☂</span><strong>Nenhum dado carregado</strong><small>Os resultados da consulta aparecerão aqui.</small>';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const value of [row.codigo, row.data, row.hora, row.chuva]) {
        const td = document.createElement("td");
        td.textContent = value || "—";
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
  }

  contador.textContent = `${rows.length} ${rows.length === 1 ? "registro" : "registros"}`;
  csvBtn.disabled = rows.length === 0;
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  const codigo = codigoInput.value.trim();
  const inicio = inicioInput.value;
  const fim = fimInput.value;

  if (!codigo || !inicio || !fim) {
    setStatus("Preencha o código da estação e as duas datas.", "warning");
    return;
  }
  if (inicio > fim) {
    setStatus("A data inicial deve ser anterior ou igual à data final.", "warning");
    return;
  }

  consultarBtn.disabled = true;
  csvBtn.disabled = true;
  resultados = [];
  renderResults([]);
  setStatus("Consultando a API da ANA...", "info");

  try {
    const url = new URL(API_URL);
    url.searchParams.set("codEstacao", codigo);
    url.searchParams.set("dataInicio", toBrazilDate(inicio));
    url.searchParams.set("dataFim", toBrazilDate(fim));

    const response = await fetch(url.toString(), {
      headers: { "Accept": "application/xml, text/xml, */*" }
    });

    if (!response.ok) throw new Error(`A API respondeu com HTTP ${response.status}.`);

    resultados = parseAnaXml(await response.text(), codigo);
    renderResults(resultados);

    if (resultados.length) {
      setStatus(`Consulta concluída: ${resultados.length} registro(s) encontrado(s).`, "success");
    } else {
      setStatus("A API respondeu, mas não foram reconhecidos registros. O formato da resposta pode ter mudado.", "warning");
    }
  } catch (error) {
    const isCors = error instanceof TypeError;
    setStatus(
      isCors
        ? "Não foi possível acessar a API diretamente do navegador. Pode ser uma restrição de CORS ou indisponibilidade do serviço. Consulte a observação no README."
        : `Falha na consulta: ${error.message}`,
      "error"
    );
  } finally {
    consultarBtn.disabled = false;
  }
});

csvBtn.addEventListener("click", () => {
  if (!resultados.length) return;

  const now = new Date();
  const pad = number => String(number).padStart(2, "0");
  const filename = `dados_pluviometricos_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;

  const escapeCsv = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Código da estação", "Data", "Hora", "Precipitação (mm)"],
    ...resultados.map(row => [row.codigo, row.data, row.hora, row.chuva])
  ];
  const csv = "\uFEFF" + rows.map(row => row.map(escapeCsv).join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  setStatus(`Arquivo exportado: ${filename}`, "success");
});
