# Tela

App de compartilhamento de tela em grupo. Voce e seus amigos entram numa "sala" digitando o mesmo codigo e podem compartilhar tela ao mesmo tempo — tipo o Discord fazia antes de bloquearem no Brasil. Funciona em Windows.

A ideia é continuar usando Discord para voz e jogar, mas quando alguem quiser compartilhar a tela só entrar em uma sala junto no aplicativo. 

**Este guia e pra quem nunca abriu um terminal na vida.** Se voce segue os passos com calma, em ~15 minutos voce tem um `.exe` pronto pra mandar pros amigos.

## Como funciona

- Voce (o "dono") cria uma conta gratis no LiveKit, cola as credenciais num arquivo, e gera um `.exe`
- Seus amigos so baixam o `.exe`, dao dois cliques, e ja podem entrar na sala
- **Sem servidor pra manter**, sem GitHub, sem Render. As credenciais LiveKit ficam embutidas no `.exe` que voce gera

## O que voce vai ter no final

- Sala virtual onde voce e amigos entram por codigo
- Multiplas pessoas compartilhando tela ao mesmo tempo
- Audio de sistema junto (util pra assistir video/jogo)
- Botao de mute individual por participante
- Um `.exe` pra mandar pros amigos

## O que voce vai precisar

Tudo gratis:

- Um computador com **Windows 10 ou 11**
- Para gerar o `.exe`: **Visual Studio Build Tools 2022** com “Desktop development with C++” e **CMake**
- ~15 minutos de paciencia
- Um e-mail (Gmail funciona)
- ~500 MB de espaco em disco

---

## Indice

1. [Instalar Node.js](#1-instalar-nodejs)
2. [Baixar o codigo (ZIP)](#2-baixar-o-codigo-zip)
3. [Criar conta no LiveKit e pegar credenciais](#3-criar-conta-no-livekit-e-pegar-credenciais)
4. [Criar o arquivo de credenciais](#4-criar-o-arquivo-de-credenciais)
5. [Abrir o PowerShell na pasta certa](#5-abrir-o-powershell-na-pasta-certa)
6. [Gerar o .exe](#6-gerar-o-exe)
7. [Distribuir pros amigos](#7-distribuir-pros-amigos)
8. [Como usar o app no dia a dia](#8-como-usar-o-app-no-dia-a-dia)
9. [Problemas comuns](#9-problemas-comuns)
10. [Atualizar depois](#10-atualizar-depois)

---

## 1. Instalar Node.js

Node.js e o "motor" que roda o app.

1. Abre https://nodejs.org
2. Clica no botao verde da **esquerda** ("LTS")
3. Baixa e da dois cliques no arquivo `.msi`
4. Clica **Next** em todas as telas, aceita a licenca
5. Numa tela chamada **"Tools for Native Modules"**, **desmarca** a caixinha (nao precisa)
6. Clica **Install**. Se o Windows pedir permissao, clica **Sim**
7. Espera ~2 min → **Finish**

---

## 2. Baixar o codigo (ZIP)

1. Abre https://github.com/lukeribeiro95/tela
2. Clica no botao verde **Code** no topo da lista de arquivos
3. No menu que abre, clica em **Download ZIP**
4. Salva o arquivo `tela-main.zip` em algum lugar facil (ex: Downloads)
5. Vai na pasta onde baixou → **clica com o botao direito** no ZIP → **Extrair Tudo** → aponta pra `Documentos` → **Extrair**
6. Agora voce tem uma pasta `Documentos\tela-main\` com o codigo

---

## 3. Criar conta no LiveKit e pegar credenciais

LiveKit e o servico que transmite o video entre voce e os amigos. Plano gratis tem 10.000 minutos/mes, mais que suficiente pra grupo pequeno.

1. Abre https://cloud.livekit.io
2. Clica **Get Started** ou **Sign up**
3. Mais facil: **Continue with Google** (usa sua conta Gmail)
4. Depois do login, cria um projeto:
   - **Project name**: qualquer coisa, ex: `tela`
   - **Region**: escolhe **South America (Sao Paulo)** se voces estao no Brasil
5. Clica **Create Project**
6. Voce entra no dashboard. No menu da esquerda, clica em **Settings** (engrenagem) → aba **Keys**
7. Copia 3 coisas:
   - **Websocket URL** (comeca com `wss://algumacoisa.livekit.cloud`)
   - **API Key** (clica na linha da tabela pra expandir → comeca com `API...`)
   - **API Secret** (na mesma linha expandida → string longa)

**Abre o Bloco de Notas e cola essas 3 coisas em ordem** — voce vai precisar delas ja ja:

```
LIVEKIT_URL = wss://xxxxx.livekit.cloud
LIVEKIT_API_KEY = APIxxxxxxxxxxxx
LIVEKIT_API_SECRET = xxxxxxxxxxxxxxxxxxxxxxxxx
```

**Nao compartilhe essas 3 coisas** com ninguem que nao seja de sua confianca — quem tiver acesso pode usar/queimar sua cota LiveKit.

---

## 4. Criar o arquivo de credenciais

Voce vai criar um arquivo chamado `credentials.json` dentro de `Documentos\tela-main\app` com suas credenciais LiveKit. Ele vai ficar embutido dentro do `.exe` que voce vai gerar.

1. Abre o **Explorador de Arquivos** e vai em `Documentos\tela-main\app`
2. Dentro dessa pasta ja existe um arquivo chamado `credentials.json.example`. Copia esse arquivo (Ctrl+C no arquivo → Ctrl+V no mesmo lugar) — vai criar `credentials.json.example - Copia.example`
3. Renomeia essa copia pra **`credentials.json`** (F2 no arquivo, apaga tudo, digita `credentials.json`, Enter)
4. **Botao direito** no arquivo → **Abrir com** → **Bloco de Notas**
5. Voce vai ver algo tipo:
   ```json
   {
     "LIVEKIT_URL": "wss://SEU-PROJETO.livekit.cloud",
     "LIVEKIT_API_KEY": "APIxxxxxxxxxxxx",
     "LIVEKIT_API_SECRET": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   }
   ```
6. **Troca** os 3 valores pelos que voce salvou no passo 3 (mantem as aspas duplas)
7. **Ctrl+S** pra salvar. Fecha o Bloco de Notas

**Atencao:** as aspas duplas `"`, dois-pontos `:`, virgulas `,` e chaves `{}` precisam estar exatamente como acima. Se o Bloco de Notas trocar as aspas por "aspas curvas" (`“` `”`), quebra.

---

## 5. Abrir o PowerShell na pasta certa

Precisamos abrir o PowerShell **ja dentro** da pasta `app`, pra rodar os comandos ali.

1. Abre o **Explorador de Arquivos** e vai em `Documentos\tela-main\app`
2. **Clica na barra de endereco no topo** (onde aparece o caminho `Documentos > tela-main > app`) — vai virar texto editavel
3. Apaga o que ta ali, digita `powershell` e aperta **Enter**
4. Abre uma janela do PowerShell **ja no caminho certo** (o prompt vai mostrar `PS C:\Users\SeuNome\Documents\tela-main\app>`)

**Dicas rapidas:**
- Pra colar comando: **botao direito** dentro da janela
- Pra parar comando travado: **Ctrl+C**
- Pra fechar: `exit` e Enter

**Testa se Node funciona:**

```
node --version
```
Deve mostrar `v20.x.x`. Se der "nao reconhecido", fecha e abre o PowerShell de novo.

**Instala as dependencias:**

```
npm install
```
Instala tudo o que o app precisa. **Demora 1 a 3 minutos.** Ignora avisos vermelhos sobre "vulnerabilities" no final — nao afetam nada.

---

## 6. Compilar o helper de áudio e gerar o .exe

Ainda no PowerShell (na pasta `Documentos\tela-main\app`):

Antes, instale o **Visual Studio Build Tools 2022** e marque o workload **Desktop development with C++** com o **Windows SDK 10.0.20348.0 ou mais novo**. Também instale o CMake (pelo instalador do Visual Studio ou em https://cmake.org/download/). Depois abra o **x64 Native Tools Command Prompt for VS 2022**, navegue até a pasta `app` e rode:

```
cmake -S native/audio-capture -B native/audio-capture/build -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build native/audio-capture/build
```

Isso gera `native\audio-capture\build\AudioCapture.exe`. Só então rode:

```
npm run dist
```

**Demora 3 a 5 minutos** na primeira vez (baixa uns 130 MB do Electron).

Quando terminar, abre o Explorador de Arquivos e vai em `Documentos\tela-main\app\dist`. Voce vai ver:

- **Tela-Portable-1.0.0.exe** (~82 MB) — portatil, roda sem instalar. **Este e o melhor pra mandar pros amigos**
- **Tela-Setup-1.0.0.exe** (~82 MB) — instalador tradicional com atalho no Menu Iniciar

**Testa antes de mandar**: da dois cliques no `Tela-Portable-1.0.0.exe`, entra com nome e um codigo qualquer, clica Entrar. Se abrir a tela da sala, ta tudo certo.

---

## 7. Distribuir pros amigos

O `.exe` tem 82 MB — grande demais pro Discord (limite 10-25 MB). Melhor caminho: **Google Drive**.

1. Vai em https://drive.google.com (entra com sua conta Gmail)
2. Botao **+ Novo** → **Upload de arquivo** → escolhe o `Tela-Portable-1.0.0.exe`
3. Espera terminar o upload
4. **Botao direito no arquivo** → **Compartilhar** → **Compartilhar**
5. Em "Acesso geral", muda de "Restrito" pra **"Qualquer pessoa com o link"**
6. Clica **Copiar link** → **Concluido**
7. Manda esse link no Discord/WhatsApp pros amigos

(Alternativas: WeTransfer, Dropbox, MediaFire — qualquer serviço de arquivos publico serve.)

### O que seus amigos fazem

1. Baixam o `.exe` do link
2. Dao dois cliques
3. **Windows SmartScreen vai reclamar** (**"Windows protegeu seu PC"**) — clicam **Mais informacoes** → **Executar assim mesmo**
4. O app abre. Preenchem **nome** e **codigo da sala** (o codigo que voces combinaram no Discord/WhatsApp)
5. Clicam **Entrar** e pronto

**Voce so precisa combinar com eles:**
- Onde baixar (link do Drive)
- Codigo da sala pra usar (ex: `NOITE-JOGO`)

---

## 8. Como usar o app no dia a dia

### Entrar numa sala
Abre o app, preenche nome + codigo, clica **Entrar**. O app lembra o que voce preencheu.

### Compartilhar sua tela
Clica **Compartilhar tela**. Escolhe uma tela ou janela no modal. Pra parar, clica de novo (agora diz **Parar compartilhamento**).

### Falar
Clica **Ligar microfone**. Pra desligar, mesmo botao (agora **Mutar microfone**).

### Mutar alguem
Cada tela remota tem botao **Mutar** no canto superior direito. Silencia o audio daquela pessoa so pra voce.

### Sair
Clica **Sair**. Fecha o app.

---

## 9. Problemas comuns

### "node nao e reconhecido"
Fecha o PowerShell e abre de novo. Se nao resolver, reinstala Node.js.

### `npm install` da erro
Verifica internet. Fecha PowerShell e tenta de novo.

### `npm run dist` falha com "credentials.json is not valid JSON"
Voce colou o JSON errado. Abre o `credentials.json` de novo no Bloco de Notas, copia o exemplo do passo 4, e cola por cima. Confere se as aspas sao normais (`"`) e nao "aspas curvas" tipo `“` `”`.

### App abre mas mostra "App nao configurado" ao clicar Entrar
Voce esqueceu de criar o `credentials.json` antes de rodar `npm run dist`. Cria o arquivo (passo 4), gera o `.exe` de novo (passo 6), distribui de novo.

### Windows SmartScreen bloqueia o `.exe`
Normal — o app nao e assinado (assinatura custa ~$100/ano). Na tela azul, clica **Mais informacoes** → **Executar assim mesmo**. So precisa fazer uma vez.

### Antivirus bloqueia
Mesmo motivo. Adiciona excecao no antivirus.

### Compartilhar tela nao funciona
Vai em **Configuracoes do Windows** → **Privacidade e seguranca** → **Gravacao de tela** → verifica que ta **Ativado**.

### Amigos veem tela preta quando compartilho
Fecha o app, abre de novo, tenta compartilhar de novo. Se persistir, compartilha uma **janela** em vez da tela toda.

### Cota LiveKit acabou
Vai no dashboard do LiveKit → Usage. Se estourou o free tier (~10.000 min/mes), aguarda o mes virar ou upgrade pro plano pago.

---

## 10. Atualizar depois

**Se voce so quer mudar as credenciais LiveKit:**
1. Abre `Documentos\tela-main\app\credentials.json` no Bloco de Notas
2. Muda os valores, Ctrl+S
3. Abre o PowerShell na pasta `app` (passo 5) e roda `npm run dist`
4. Distribui o novo `.exe`

**Se sair uma versao nova do template:**
1. Baixa o ZIP de novo (passo 2), extrai por cima da pasta velha (ou numa nova)
2. Copia seu `credentials.json` antigo pra dentro da nova pasta `app`
3. Roda `npm install` e `npm run dist` no PowerShell
4. Distribui o novo `.exe`

---

## Limitacoes

- **LiveKit free tier**: 10.000 minutos/mes de duracao total. Grupo casual sobra.
- **Credenciais ficam dentro do `.exe`**: sao extraíveis por alguem com conhecimento tecnico (o `.exe` e um arquivo `.asar` que pode ser aberto). So distribui pra pessoas de confianca. Se vazar, rotaciona as credenciais no dashboard do LiveKit.
- **App nao assinado**: SmartScreen e antivirus reclamam. Solucao: certificado de assinatura ~$100/ano.
- **Audio de sistema so no Windows**: macOS e Linux nao capturam audio do sistema junto do screen share.

### Áudio do sistema sem Discord

O áudio filtrado usa a API oficial **WASAPI Application/Process Loopback** do Windows. O helper `AudioCapture.exe` exclui a árvore do processo `Discord.exe`, `DiscordCanary.exe` ou `DiscordPTB.exe` antes de enviar PCM ao app. O Electron transforma esse PCM em uma track Web Audio e a publica no LiveKit como `screen_share_audio`; o vídeo continua sendo publicado sem áudio pelo fluxo normal de compartilhamento.

Comandos exatos, executados dentro da pasta `app` no **x64 Native Tools Command Prompt for VS 2022**:

```
cmake -S native/audio-capture -B native/audio-capture/build -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build native/audio-capture/build
npm run start
```

Para gerar o portátil e o instalador depois de compilar o helper:

```
npm run dist
```

O `electron-builder` copia o helper para `resources\audio-capture\AudioCapture.exe`, portanto o mesmo caminho funciona no desenvolvimento e nos executáveis portable/instalador.

#### Como testar a exclusão

1. Entre na mesma sala em dois clientes (ou use outro participante) e comece a compartilhar tela com **Compartilhar áudio do sistema** marcado.
2. Toque uma música/vídeo em um aplicativo que não seja o Discord: o outro participante deve ouvir.
3. No Discord, entre em um canal e reproduza o mesmo áudio apenas por ele; o outro participante não deve ouvir esse áudio pelo compartilhamento.
4. Feche e abra o Discord durante uma captura. O helper interrompe somente o áudio e o app mostra uma mensagem; reinicie o compartilhamento de áudio para criar uma nova exclusão. O vídeo não cai.

#### Requisito mínimo e limitação da API do Windows

É obrigatório Windows 10 **build 20348** ou superior (ou Windows 11). Essa é a versão mínima documentada para `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` e `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`.

A API recebe somente **um** PID e exclui esse processo mais os filhos. Normalmente todas as janelas/processos de uma instalação do Discord pertencem à mesma árvore, que é detectada automaticamente. Se houver duas árvores independentes de Discord, o helper não inicia o áudio por segurança — misturá-las não eliminaria o Discord de forma correta. Do mesmo modo, se o Discord for iniciado/reiniciado depois da captura, o helper encerra o áudio e exige reinício; a API não oferece uma regra dinâmica de “excluir todo executável chamado Discord”.

---

## Licenca

MIT — usa como quiser.
