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
let gameState = 'LOBBY';
let buzzerQueue = [];
let currentAnsweringIndex = 0;
let eliminatedOptions = [];
let isReadyToStart = false;
let autoNextTimer = null;

function decodeHTML(html) {
    return html.replace(/&quot;/g, '"')
               .replace(/&#039;/g, "'")
               .replace(/&amp;/g, '&')
               .replace(/&eacute;/g, 'é')
               .replace(/&ouml;/g, 'ö')
               .replace(/&rsquo;/g, "'")
               .replace(/&ldquo;/g, '"')
               .replace(/&rdquo;/g, '"');
}

// Funzione di traduzione con pausa di sicurezza anti-blocco IP
async function translateText(text) {
    if (!text || text.trim() === "") return "";
    try {
        // Pausa di 300ms per evitare il ban di Google per troppe richieste rapide
        await new Promise(resolve => setTimeout(resolve, 300));

        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=it&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const data = await res.json();
        
        if (data && data[0]) {
            let translated = data[0].map(item => item[0]).join('');
            return decodeHTML(translated);
        }
    } catch (e) {
        console.error("Errore di traduzione con Google Translate:", e);
    }
    return text; // Fallback al testo originale in caso di errore di rete
}

async function fetchAndTranslateQuestions() {
    console.log("Scaricamento e traduzione delle domande in corso...");
    isReadyToStart = false;
    io.emit('loading_status', "Scaricamento e traduzione domande in corso... Attendere.");

    try {
        // Scarichiamo 15 domande per renderlo velocissimo e sicurissimo contro i blocchi
        const response = await fetch('https://opentdb.com/api.php?amount=15&type=multiple');
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
            let loadedQuestions = [];
            
            for (let i = 0; i < data.results.length; i++) {
                let q = data.results[i];
                
                let rawQuestionEn = decodeHTML(q.question);
                let rawCategoryEn = decodeHTML(q.category);
                let rawCorrectEn = decodeHTML(q.correct_answer);
                let rawIncorrectsEn = q.incorrect_answers.map(ans => decodeHTML(ans));

                // Traduce in italiano in modo scaglionato
                let questionIt = await translateText(rawQuestionEn);
                let categoryIt = await translateText(rawCategoryEn);
                
                let optionsEnList = [...rawIncorrectsEn, rawCorrectEn].sort(() => Math.random() - 0.5);
                
                let optionsEn = {};
                let optionsIt = {};
                const keys = ['A', 'B', 'C', 'D'];

                optionsEnList.forEach((optEn, idx) => {
                    optionsEn[keys[idx]] = optEn;
                });

                let finalCorrectKey = 'A';
                for (let idx = 0; idx < optionsEnList.length; idx++) {
                    let key = keys[idx];
                    let translatedOpt = await translateText(optionsEnList[idx]);
                    optionsIt[key] = translatedOpt;
                    if (optionsEnList[idx] === rawCorrectEn) {
                        finalCorrectKey = key;
                    }
                }

                loadedQuestions.push({
                    id: i + 1,
                    categoryEn: rawCategoryEn,
                    categoryIt: categoryIt,
                    questionEn: rawQuestionEn,
                    questionIt: questionIt,
                    optionsEn: optionsEn,
                    optionsIt: optionsIt,
                    correct: finalCorrectKey
                });
            }

            questions = loadedQuestions;
            isReadyToStart = true;
            console.log(`✅ Tradotte e caricate con successo ${questions.length} domande!`);
            io.emit('loading_status', "");
            io.emit('update_state', getGameStatePayload());
        }
    } catch (err) {
        console.error("Errore nel recupero delle domande:", err);
        io.emit('loading_status', "Errore di caricamento domande. Ricarica la pagina.");
    }
}

fetchAndTranslateQuestions();

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

    socket.on('start_game', () => {
        if (!isReadyToStart || teams.length === 0 || questions.length === 0) return;
        currentQuestionIndex = 0;
        startQuestion();
    });

    socket.on('reset_game', () => {
        if (autoNextTimer) clearTimeout(autoNextTimer);
        gameState = 'LOBBY';
        currentQuestionIndex = -1;
        buzzerQueue = [];
        currentAnsweringIndex = 0;
        eliminatedOptions = [];
        teams.forEach(t => t.score = 0);

        io.emit('update_teams', teams);
        io.emit('update_state', getGameStatePayload());
    });

    socket.on('press_buzzer', () => {
        if (gameState !== 'QUESTION_OPEN') return;
        const team = teams.find(t => t.id === socket.id);
        if (!team) return;

        if (buzzerQueue.some(b => b.socketId === socket.id)) return;

        const timestamp = Date.now();
        const relativeTime = buzzerQueue.length === 0 ? 0 : ((timestamp - buzzerQueue[0].timestamp) / 1000).toFixed(3);

        buzzerQueue.push({
            socketId: socket.id,
            teamName: team.name,
            timestamp: timestamp,
            delay: relativeTime
        });

        if (buzzerQueue.length === 1) {
            gameState = 'ANSWERING';
            currentAnsweringIndex = 0;
        }

        io.emit('update_state', getGameStatePayload());
    });

    socket.on('submit_answer', (chosenOption) => {
        if (gameState !== 'ANSWERING') return;

        const currentTeamInQueue = buzzerQueue[currentAnsweringIndex];
        if (!currentTeamInQueue || currentTeamInQueue.socketId !== socket.id) return;

        const currentQ = questions[currentQuestionIndex];

        if (chosenOption === currentQ.correct) {
            let pointsAwarded = (currentAnsweringIndex === 0) ? 1.0 : 0.5;
            let teamObj = teams.find(t => t.id === socket.id);
            if (teamObj) teamObj.score += pointsAwarded;

            gameState = 'QUESTION_ENDED';
            io.emit('answer_result', {
                correct: true,
                teamName: teamObj ? teamObj.name : '',
                points: pointsAwarded,
                correctOption: currentQ.correct
            });
            io.emit('update_teams', teams);
            io.emit('update_state', getGameStatePayload());

            scheduleNextQuestion();
        } else {
            eliminatedOptions.push(chosenOption);

            if (currentAnsweringIndex === 0 && buzzerQueue.length > 1) {
                currentAnsweringIndex = 1;
                io.emit('answer_result', {
                    correct: false,
                    teamName: currentTeamInQueue.teamName,
                    message: "Risposta errata! Opzione eliminata. Turno alla seconda squadra!"
                });
                io.emit('update_state', getGameStatePayload());
            } else {
                gameState = 'QUESTION_ENDED';
                io.emit('answer_result', {
                    correct: false,
                    teamName: currentTeamInQueue.teamName,
                    message: "Tentativi esauriti! Nessun punto assegnato.",
                    correctOption: currentQ.correct
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

function startQuestion() {
    if (autoNextTimer) clearTimeout(autoNextTimer);
    gameState = 'QUESTION_OPEN';
    buzzerQueue = [];
    currentAnsweringIndex = 0;
    eliminatedOptions = [];
    io.emit('update_state', getGameStatePayload());
}

function scheduleNextQuestion() {
    if (autoNextTimer) clearTimeout(autoNextTimer);
    
    autoNextTimer = setTimeout(() => {
        currentQuestionIndex++;
        if (currentQuestionIndex < questions.length) {
            startQuestion();
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
