const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let questions = [];
let teams = [];
let currentQuestionIndex = -1;
let gameState = 'LOBBY'; // LOBBY, BUZZER_WINDOW, ANSWERING, QUESTION_ENDED, GAME_OVER
let buzzerQueue = [];
let currentAnsweringIndex = 0;
let eliminatedOptions = [];
let isReadyToStart = false;
let autoNextTimer = null;
let buzzerWindowTimer = null;

function decodeHTML(html) {
    if (!html) return "";
    return html.replace(/&quot;/g, '"')
               .replace(/&#039;/g, "'")
               .replace(/&amp;/g, '&')
               .replace(/&eacute;/g, 'é')
               .replace(/&ouml;/g, 'ö')
               .replace(/&rsquo;/g, "'")
               .replace(/&ldquo;/g, '"')
               .replace(/&rdquo;/g, '"');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function translateText(text) {
    if (!text || text.trim() === "") return "";
    let cleanText = decodeHTML(text);

    try {
        await delay(200);
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=it&dt=t&q=${encodeURIComponent(cleanText)}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!res.ok) return cleanText;

        const data = await res.json();
        if (data && Array.isArray(data[0])) {
            let translated = data[0].map(item => item[0] ? item[0] : '').join('');
            if (translated.trim() !== "") {
                return decodeHTML(translated);
            }
        }
    } catch (e) {
        console.error("Errore traduzione:", e.message);
    }
    return cleanText;
}

async function fetchRawQuestions() {
    console.log("🔄 Scaricamento rapido domande grezze...");
    isReadyToStart = false;
    io.emit('loading_status', "Caricamento domande in corso...");

    try {
        const response = await fetch('https://opentdb.com/api.php?amount=25&type=multiple');
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
            let loadedQuestions = [];
            
            for (let i = 0; i < data.results.length; i++) {
                let q = data.results[i];
                
                let rawQuestionEn = decodeHTML(q.question);
                let rawCategoryEn = decodeHTML(q.category);
                let rawCorrectEn = decodeHTML(q.correct_answer);
                let rawIncorrectsEn = q.incorrect_answers.map(ans => decodeHTML(ans));

                let optionsEnList = [...rawIncorrectsEn, rawCorrectEn].sort(() => Math.random() - 0.5);
                let optionsEn = {};
                const keys = ['A', 'B', 'C', 'D'];

                optionsEnList.forEach((optEn, idx) => {
                    optionsEn[keys[idx]] = optEn;
                });

                let finalCorrectKey = 'A';
                optionsEnList.forEach((optEn, idx) => {
                    if (optEn === rawCorrectEn) {
                        finalCorrectKey = keys[idx];
                    }
                });

                loadedQuestions.push({
                    id: i + 1,
                    categoryEn: rawCategoryEn,
                    categoryIt: null,
                    questionEn: rawQuestionEn,
                    questionIt: null,
                    optionsEn: optionsEn,
                    optionsIt: null,
                    correct: finalCorrectKey,
                    translated: false
                });
            }

            questions = loadedQuestions;
            isReadyToStart = true;
            console.log(`✅ ${questions.length} domande pronte in memoria!`);
            io.emit('loading_status', "");
            io.emit('update_state', getGameStatePayload());
        }
    } catch (err) {
        console.error("Errore nel recupero:", err);
        io.emit('loading_status', "Errore di caricamento. Ricarica la pagina.");
    }
}

fetchRawQuestions();

async function ensureQuestionTranslated(index) {
    let q = questions[index];
    if (q.translated) return;

    console.log(`🌐 Traduzione on-demand della domanda ${index + 1}...`);
    q.categoryIt = await translateText(q.categoryEn);
    q.questionIt = await translateText(q.questionEn);

    let optionsIt = {};
    for (let key of Object.keys(q.optionsEn)) {
        optionsIt[key] = await translateText(q.optionsEn[key]);
    }
    q.optionsIt = optionsIt;
    q.translated = true;
}

io.on('connection', (socket) => {
    console.log(`Dispositivo connesso: ${socket.id}`);

    socket.emit('update_state', {
        gameState,
        teams,
        currentQuestion: currentQuestionIndex >= 0 ? questions[currentQuestionIndex] : null,
        buzzerQueue,
        currentAnsweringIndex,
        eliminatedOptions,
        isReadyToStart
    });

    socket.on('register_team', (teamName) => {
        if (!teamName || teamName.trim() === "") return;
        const exists = teams.some(t => t.name.toLowerCase() === teamName.toLowerCase());
        if (exists) {
            socket.emit('registration_error', 'Questo nome è già stato scelto!');
            return;
        }

        teams.push({ id: socket.id, name: teamName.trim(), score: 0 });
        socket.emit('registration_success', teamName.trim());
        io.emit('update_teams', teams);
        io.emit('update_state', getGameStatePayload());
    });

    socket.on('start_game', async () => {
        if (!isReadyToStart || teams.length === 0 || questions.length === 0) return;
        currentQuestionIndex = 0;
        await startQuestion();
    });

    socket.on('reset_game', () => {
        if (autoNextTimer) clearTimeout(autoNextTimer);
        if (buzzerWindowTimer) clearTimeout(buzzerWindowTimer);
        gameState = 'LOBBY';
        currentQuestionIndex = -1;
        buzzerQueue = [];
        currentAnsweringIndex = 0;
        eliminatedOptions = [];
        teams.forEach(t => t.score = 0);

        io.emit('update_teams', teams);
        io.emit('update_state', getGameStatePayload());
    });

    // Registrazione della pressione del buzzer durante la finestra temporale
    socket.on('press_buzzer', () => {
        if (gameState !== 'BUZZER_WINDOW') return;
        const team = teams.find(t => t.id === socket.id);
        if (!team) return;

        // Evita che la stessa squadra prema due volte nella stessa finestra
        if (buzzerQueue.some(b => b.socketId === socket.id)) return;

        const timestamp = Date.now();
        buzzerQueue.push({
            socketId: socket.id,
            teamName: team.name,
            timestamp: timestamp
        });

        io.emit('update_state', getGameStatePayload());
    });

    socket.on('submit_answer', (chosenOption) => {
        if (gameState !== 'ANSWERING') return;

        const currentTeamInQueue = buzzerQueue[currentAnsweringIndex];
        if (!currentTeamInQueue || currentTeamInQueue.socketId !== socket.id) return;

        const currentQ = questions[currentQuestionIndex];

        if (chosenOption === currentQ.correct) {
            let teamObj = teams.find(t => t.id === socket.id);
            if (teamObj) teamObj.score += 1.0;

            gameState = 'QUESTION_ENDED';
            io.emit('answer_result', {
                correct: true,
                teamName: teamObj ? teamObj.name : '',
                points: 1.0
            });
            io.emit('update_teams', teams);
            io.emit('update_state', getGameStatePayload());

            scheduleNextQuestion();
        } else {
            eliminatedOptions.push(chosenOption);

            if (currentAnsweringIndex + 1 < buzzerQueue.length) {
                currentAnsweringIndex++;
                const nextTeam = buzzerQueue[currentAnsweringIndex];
                io.emit('answer_result', {
                    correct: false,
                    teamName: currentTeamInQueue.teamName,
                    message: `Risposta errata! Turno a ${nextTeam.teamName}.`
                });
                io.emit('update_state', getGameStatePayload());
            } else {
                gameState = 'QUESTION_ENDED';
                io.emit('answer_result', {
                    correct: false,
                    teamName: currentTeamInQueue.teamName,
                    message: "Tentativi esauriti per tutte le squadre in coda! Nessun punto."
                });
                io.emit('update_state', getGameStatePayload());

                scheduleNextQuestion();
            }
        }
    });

    socket.on('disconnect', () => {
        teams = teams.filter(t => t.id !== socket.id);
        io.emit('update_teams', teams);
        io.emit('update_state', getGameStatePayload());
    });
});

async function startQuestion() {
    if (autoNextTimer) clearTimeout(autoNextTimer);
    if (buzzerWindowTimer) clearTimeout(buzzerWindowTimer);

    await ensureQuestionTranslated(currentQuestionIndex);

    gameState = 'BUZZER_WINDOW'; // Finestra aperta in cui tutti possono premere per 3 secondi
    buzzerQueue = [];
    currentAnsweringIndex = 0;
    eliminatedOptions = [];
    io.emit('update_state', getGameStatePayload());

    // Dopo esattamente 3 secondi, chiudiamo la finestra di prenotazione, ordiniamo i click e passiamo al primo
    buzzerWindowTimer = setTimeout(() => {
        if (gameState !== 'BUZZER_WINDOW') return;

        // Ordiniamo la coda in base al timestamp cronologico (dal più veloce al più lento)
        buzzerQueue.sort((a, b) => a.timestamp - b.timestamp);

        // Calcoliamo i ritardi relativi rispetto al primo in classifica
        if (buzzerQueue.length > 0) {
            const firstTime = buzzerQueue[0].timestamp;
            buzzerQueue.forEach((b, idx) => {
                b.delay = idx === 0 ? "0.000" : ((b.timestamp - firstTime) / 1000).toFixed(3);
            });
            gameState = 'ANSWERING';
            currentAnsweringIndex = 0;
        } else {
            // Nessuno ha premuto in 3 secondi: saltiamo la domanda o passiamo oltre
            gameState = 'QUESTION_ENDED';
            io.emit('answer_result', {
                correct: false,
                teamName: "Nessuno",
                message: "Tempo scaduto per le prenotazioni! Nessuno ha premuto."
            });
            scheduleNextQuestion();
        }

        io.emit('update_state', getGameStatePayload());
    }, 3000);
}

function scheduleNextQuestion() {
    if (autoNextTimer) clearTimeout(autoNextTimer);
    
    autoNextTimer = setTimeout(async () => {
        currentQuestionIndex++;
        if (currentQuestionIndex < questions.length) {
            await startQuestion();
        } else {
            gameState = 'GAME_OVER';
            io.emit('game_over', { teams });
        }
    }, 5000);
}

function getGameStatePayload() {
    return {
        gameState,
        teams,
        currentQuestion: currentQuestionIndex >= 0 ? questions[currentQuestionIndex] : null,
        buzzerQueue,
        currentAnsweringIndex,
        eliminatedOptions,
        questionNumber: currentQuestionIndex + 1,
        totalQuestions: questions.length,
        isReadyToStart
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
});
