import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeToolRefusal } from "../../open-sse/translator/webTools.ts";

// #adapta-refusal-retry: the refusal detector decides whether a tool-aware upstream
// reply is retryable. It must catch the refusal dialects observed live on adapta-web
// (Claude 5.5 Sonnet / Kimi K2.7 Code) and — just as importantly — NOT flag ordinary
// final answers, which would burn an extra upstream call and could replace a correct
// answer with a worse one.

test("looksLikeToolRefusal flags an explicit access denial", () => {
  assert.equal(looksLikeToolRefusal("Não tenho acesso a ferramentas neste ambiente."), true);
  assert.equal(
    looksLikeToolRefusal("I don't have access to the terminal, so I cannot run that command."),
    true
  );
  assert.equal(looksLikeToolRefusal("I cannot use a terminal here."), true);
  assert.equal(looksLikeToolRefusal("The terminal is not available in this session."), true);
});

test("looksLikeToolRefusal flags the platform-only-catalog confabulation", () => {
  assert.equal(
    looksLikeToolRefusal(
      "As ferramentas da plataforma estão ativas, mas o terminal não está disponível nesta sessão."
    ),
    true
  );
  assert.equal(
    looksLikeToolRefusal(
      "The client tools are not actually registered here — only the platform catalog is active."
    ),
    true
  );
  assert.equal(
    looksLikeToolRefusal("Only the platform-level tool registry is available in this chat."),
    true
  );
});

test("looksLikeToolRefusal flags the duplicate-session confabulation", () => {
  assert.equal(
    looksLikeToolRefusal(
      "Parece que há uma sessão duplicada; a execução aconteceu em outro ambiente."
    ),
    true
  );
  assert.equal(
    looksLikeToolRefusal("This looks like a separate session — the tool ran elsewhere."),
    true
  );
});

test("looksLikeToolRefusal flags stated intent that never emitted a tool block", () => {
  assert.equal(looksLikeToolRefusal("Vou criar o arquivo agora mesmo."), true);
  assert.equal(looksLikeToolRefusal("Let me run the tests first."), true);
  assert.equal(looksLikeToolRefusal("I'll write the file to disk."), true);
});

test("looksLikeToolRefusal returns false for a legitimate final answer", () => {
  assert.equal(looksLikeToolRefusal("O arquivo tem 412 linhas e exporta 3 funções."), false);
  assert.equal(
    looksLikeToolRefusal("Pronto — criei o documento com as 5 seções que você pediu."),
    false
  );
  assert.equal(looksLikeToolRefusal("The file has 412 lines and exports 3 functions."), false);
  assert.equal(
    looksLikeToolRefusal("I created the document with the 5 sections you asked for."),
    false
  );
  assert.equal(looksLikeToolRefusal(""), false);
  assert.equal(looksLikeToolRefusal("   \n  "), false);
  assert.equal(looksLikeToolRefusal(null), false);
  assert.equal(looksLikeToolRefusal(undefined), false);
});

test("looksLikeToolRefusal does not flag prose that merely mentions tools", () => {
  assert.equal(
    looksLikeToolRefusal("The shell command ran successfully and returned 3 lines of output."),
    false
  );
  assert.equal(
    looksLikeToolRefusal("Use the terminal tool to run `npm test` when you are ready."),
    false
  );
  assert.equal(
    looksLikeToolRefusal("Tooling note: the repository uses npm scripts for every task."),
    false
  );
});

// Second wave of live captures (same VPS run, after the first wave of patterns landed).
// These use yet other denial shapes: "não tem acesso a" (have-not vs there-is-not),
// a backtick-quoted tool name ("a ferramenta `terminal` não está disponível"), and
// "ferramenta indisponível" / "não chegou a rodar".
test("looksLikeToolRefusal flags the second wave of live-captured adapts refusals", () => {
  const liveRefusals = [
    "Não consigo listar os arquivos do diretório: este ambiente não tem acesso a terminal ou sistema de arquivos. As ferramentas disponíveis aqui são de pesquisa web, geração de conteúdo (documentos, planilhas, apresentações, imagens, diagramas) e integrações com serviços externos.",
    "Não consigo executar comandos de terminal nesta conversa — a ferramenta `terminal` não está disponível neste ambiente. O que tenho aqui são ferramentas da plataforma (pesquisa web, geração de documentos, planilhas, imagens, apresentações, diagramas, integrações e skills).",
    "Não consigo listar os arquivos do diretório: nesta conversa não tenho ferramenta de terminal disponível. As ferramentas que tenho aqui são de pesquisa web, geração de documentos/planilhas/imagens/apresentações e integrações com apps externos — nenhuma executa comandos no seu sistema de arquivos.",
    "Não consigo executar comandos de terminal nesta conversa — na prática, o comando `ls` não chegou a rodar e voltou como ferramenta indisponível. As ferramentas realmente ativas aqui são as da plataforma (pesquisa web, análise de arquivos, geração de documentos/planilhas/apresentações, conectores).",
    "Não consigo executar comandos de terminal nesta conversa — a ferramenta `terminal` não está disponível no ambiente em que estou rodando aqui. A chamada falhou com erro de ferramenta indisponível, então a listagem de arquivos do diretório atual não pôde ser feita.",
  ];

  for (const refusal of liveRefusals) {
    assert.equal(
      looksLikeToolRefusal(refusal),
      true,
      `live-captured refusal was not detected: ${refusal.slice(0, 80)}`
    );
  }
});

// #adapta-refusal-retry-live: the refusals below were captured VERBATIM from live
// adapta-web (Kimi K2.7 Code) tool-aware calls against the VPS. The first version of
// the detector matched only 1 of 8 — the denial is phrased around the ACTION ("não
// consigo executar", "o ambiente não expõe") rather than around "access to the tool",
// so the English-centric patterns missed almost every live refusal. Each string here is
// a verbatim capture; the detector must flag all of them or the retry never fires.
test("looksLikeToolRefusal flags the refusals captured live from adapta-web", () => {
  const liveRefusals = [
    "Não consigo executar comandos de terminal nesta sessão — o ambiente disponível aqui não expõe essa ferramenta, então não tenho como rodar `ls` nem ler o diretório atual.\n\nO que posso fazer no lugar:\n\n- **Se você colar a saída do `ls`** (ou de `ls -la`, `tree -L 2`), eu analiso.",
    "Não consigo executar comandos de terminal nesta conversa. Aqui eu rodo como a interface de chat do Adapta ONE, e as ferramentas ligadas a este chat são as de pesquisa na web, análise/geração de arquivos (planilhas, PDFs, documentos), imagens, apresentações e integrações com serviços externos — não há acesso a shell nem ao sistema de arquivos da sua máquina.",
    "Não consigo executar comandos de terminal nesta conversa — a ferramenta não está disponível no ambiente atual.",
    "O ambiente desta conversa não tem acesso a terminal, shell ou sistema de arquivos — as ferramentas disponíveis são as da plataforma Adapta ONE (pesquisa web, geração de documentos, planilhas, apresentações, imagens, diagramas, integrações e cursos).",
    "Não consigo executar essa listagem aqui.",
    "Não consigo executar comandos de terminal nesta sessão. As ferramentas realmente disponíveis aqui são as de pesquisa e geração (busca web, documentos, planilhas, apresentações, imagens, entre outras) — não há ferramenta de sistema de arquivos ou shell ativa.",
    "Não consegui executar o comando: esta sessão não tem acesso ao terminal nem a ferramentas de arquivos (leitura, escrita, `bash`, `glob` ou `grep`).",
    "Não consegui executar o comando de terminal: o ambiente retornou que a ferramenta `terminal` deu erro",
  ];

  for (const refusal of liveRefusals) {
    assert.equal(
      looksLikeToolRefusal(refusal),
      true,
      `live-captured refusal was not detected: ${refusal.slice(0, 80)}`
    );
  }
});
