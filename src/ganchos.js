// Pontos de extensão compartilhados (sem dependências, para evitar ciclos de importação).
export const aoConfirmarPagamento = []; // funções chamadas quando uma cobrança é paga
export const HANDLERS = {};             // tarefas agendadas (jobs) por tipo
export const periodicas = [];          // rotinas rodadas a cada ciclo do agendador (1 min)
