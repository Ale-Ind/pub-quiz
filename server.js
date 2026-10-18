const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let questions = [];
let teams = []; // { id, name, score }
let currentQuestionIndex = -1;
let gameState = 'LOBBY'; // LOBBY, QUESTION_OPEN, ANSWERING, QUESTION_ENDED, GAME_OVER
let buzzerQueue = []; // [{ socketId, teamName, timestamp, delay }]
let currentAnsweringIndex = 0;
let eliminatedOptions = [];

// Funzione per decodificare caratteri HTML speciali
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

// Funzione di traduzione automatica GRATUITA e ILLIMITATA con Google Translate
async function translateText(text) {
    if (!text || text.trim() === "") return "";
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=it&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data && data[0]) {
            let translated = data[0].map(item => item[0]).join('');
            return decodeHTML(translated);
        }
    } catch (e) {
        console.error("Errore di traduzione con Google Translate:", e);
    }
    return text;
}

// Scarica le domande in inglese e le traduce in italiano
async function fetchAndTranslateQuestions() {
    console.log("Scaricamento e traduzione delle domande in corso...");
    try {
        const response = await fetch('https://opentdb.com/api.php?amount=30&type=multiple');
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
            let loadedQuestions = [];
            
            for (let i = 0; i < data.results.length; i++) {
                let q = data.results[i];
                
                let rawQuestionEn = decodeHTML(q.question);
                let rawCategoryEn = decodeHTML(q.category);
                let rawCorrectEn = decodeHTML(q.correct_answer);
                let rawIncorrectsEn = q.incorrect_answers.map(ans => decodeHTML(ans));

                let questionIt = await translateText(rawQuestionEn);
                let categoryIt = await translateText(rawCategoryEn);
                
                let optionsEnList = [...rawIncorrectsEn, rawCorrectEn].sort(() => Math.random() - 0.5);
                
                let optionsEn = {};
                let optionsIt = {};
                const keys = ['A', 'B', 'C', 'D'];

                optionsEnList.forEach((optEn, idx) => {
                    let key = keys[idx];
                    optionsEn[key] = optEn;
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
            console.log(`✅ Tradotte e caricate con successo ${questions.length} domande!`);
        }
    } catch (err) {
        console.error("Errore nel recupero delle domande:", err);
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
        eliminatedOptions
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
    });

    socket.on('start_game', () => {
        if (teams.length === 0 || questions.length === 0) return;
        currentQuestionIndex = 0;
        startQuestion();
    });

    socket.on('next_question', () => {
        currentQuestionIndex++;
        if (currentQuestionIndex < questions.length) {
            startQuestion();
        } else {
            gameState = 'GAME_OVER';
            io.emit('game_over', { teams });
        }
    });

    // NUOVO: reset/interruzione partita
    socket.on('reset_game', () =>
