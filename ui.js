// ============================================================
//  ui.js  —  UI controller: renders board, handles input,
//             drives game loop
// ============================================================

let game = new ChessGame();
let ai = new ChessAI();
let selectedSquare = null;
let legalMovesCache = [];
let boardFlipped = false;
let pendingPromotion = null;
let aiRunning = false;
let aiVsAiInterval = null;

// --- Web Worker setup (avec fallback synchrone) ---
let aiWorker = null;
let workerAvailable = false;
let _workerTimer = null;

function _workerFallback() {
    clearTimeout(_workerTimer);
    _workerTimer = null;
    if (aiWorker) aiWorker.onmessage = null;
    workerAvailable = false;
    aiRunning = false;
    if (!game.gameOver) runAI();
}

(function initWorker() {
    try {
        aiWorker = new Worker('ai.worker.js');
        aiWorker.onmessage = null;
        aiWorker.onerror = () => _workerFallback();
        workerAvailable = true;
    } catch (e) {
        workerAvailable = false;
    }
})();

// -------------------------------------------------------
//  DOM references
// -------------------------------------------------------
const boardEl         = document.getElementById('board');
const statusMsg       = document.getElementById('status-message');
const turnColorEl     = document.getElementById('turn-color');
const evalFill        = document.getElementById('eval-fill');
const evalScore       = document.getElementById('eval-score');
const historyList     = document.getElementById('history-list');
const nodesCount      = document.getElementById('nodes-count');
const depthReached    = document.getElementById('depth-reached');
const calcTime        = document.getElementById('calc-time');
const bestMoveDisplay = document.getElementById('best-move-display');
const aiThinking      = document.getElementById('ai-thinking');
const capturedBlack   = document.getElementById('captured-black-pieces');
const capturedWhite   = document.getElementById('captured-white-pieces');
const gameModeSelect  = document.getElementById('game-mode');
const playerColorSel  = document.getElementById('player-color');
const aiDepthSel      = document.getElementById('ai-depth');

// -------------------------------------------------------
//  Board rendering
// -------------------------------------------------------

function buildBoard() {
    boardEl.innerHTML = '';

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const boardRow = boardFlipped ? 7 - r : r;
            const boardCol = boardFlipped ? 7 - c : c;

            const sq = document.createElement('div');
            sq.className = 'square ' + ((boardRow + boardCol) % 2 === 0 ? 'light' : 'dark');
            sq.dataset.row = boardRow;
            sq.dataset.col = boardCol;
            sq.addEventListener('click', onSquareClick);

            // Rank number in the top-left corner of the left column (chess.com style)
            if (c === 0) {
                const lbl = document.createElement('span');
                lbl.className = 'coord-rank';
                lbl.textContent = 8 - boardRow;
                sq.appendChild(lbl);
            }
            // File letter in the bottom-right corner of the bottom row
            if (r === 7) {
                const lbl = document.createElement('span');
                lbl.className = 'coord-file';
                lbl.textContent = String.fromCharCode(97 + boardCol);
                sq.appendChild(lbl);
            }

            boardEl.appendChild(sq);
        }
    }

    renderPieces();
}

function renderPieces() {
    document.querySelectorAll('.square').forEach(sq => {
        const r = parseInt(sq.dataset.row);
        const c = parseInt(sq.dataset.col);
        const piece = game.board[r][c];

        // Remove piece elements only — coord labels (.coord-rank / .coord-file) must stay
        sq.querySelectorAll('.piece').forEach(el => el.remove());
        sq.classList.remove('selected', 'legal-move', 'legal-capture', 'check',
                            'last-move-from', 'last-move-to');

        if (piece) {
            const el = document.createElement('span');
            el.className = 'piece ' + (isWhitePiece(piece) ? 'piece-white' : 'piece-black');
            el.textContent = PIECE_SYMBOLS[piece] || '';
            sq.appendChild(el);
        }

        // Highlights
        if (selectedSquare && selectedSquare[0] === r && selectedSquare[1] === c) {
            sq.classList.add('selected');
        }

        // Legal move dots
        const isLegal = legalMovesCache.find(m => m.to[0] === r && m.to[1] === c);
        if (isLegal) {
            sq.classList.add(piece ? 'legal-capture' : 'legal-move');
        }

        // Last move highlight
        if (game.moveList.length > 0) {
            const last = game.moveList[game.moveList.length - 1];
            if (last.from[0] === r && last.from[1] === c) sq.classList.add('last-move-from');
            if (last.to[0] === r && last.to[1] === c)   sq.classList.add('last-move-to');
        }

        // King in check
        if ((piece === PIECES.W_KING || piece === PIECES.B_KING) && game.isInCheck(pieceColor(piece))) {
            sq.classList.add('check');
        }
    });
}

// -------------------------------------------------------
//  Click handler
// -------------------------------------------------------

function onSquareClick(e) {
    if (game.gameOver || aiRunning || pendingPromotion) return;

    const mode = gameModeSelect.value;
    if (mode === 'ai-vs-ai') return;

    const playerColor = playerColorSel.value;
    if (mode === 'human-vs-ai' && game.turn !== playerColor) return;

    const r = parseInt(e.currentTarget.dataset.row);
    const c = parseInt(e.currentTarget.dataset.col);
    const piece = game.board[r][c];

    // If a square is already selected
    if (selectedSquare) {
        const move = legalMovesCache.find(m => m.to[0] === r && m.to[1] === c);
        if (move) {
            // Handle promotion
            if (move.promotion) {
                // There might be multiple promotions to the same square
                const promos = legalMovesCache.filter(m => m.to[0] === r && m.to[1] === c && m.promotion);
                if (promos.length > 1) {
                    showPromotionDialog(promos);
                    return;
                }
            }
            executeMove(move);
            return;
        }
        // Reselect own piece
        if (piece && pieceColor(piece) === game.turn) {
            selectSquare(r, c);
            return;
        }
        deselectSquare();
        return;
    }

    // Select a piece
    if (piece && pieceColor(piece) === game.turn) {
        selectSquare(r, c);
    }
}

function selectSquare(r, c) {
    selectedSquare = [r, c];
    legalMovesCache = game.getLegalMovesFrom(r, c);
    renderPieces();
}

function deselectSquare() {
    selectedSquare = null;
    legalMovesCache = [];
    renderPieces();
}

function executeMove(move) {
    const result = game.makeMove(move);
    selectedSquare = null;
    legalMovesCache = [];
    renderPieces();
    updateSidePanels(result);
    checkGameOver();

    if (!game.gameOver) {
        const mode = gameModeSelect.value;
        if (mode === 'human-vs-ai') {
            const playerColor = playerColorSel.value;
            if (game.turn !== playerColor) {
                setTimeout(runAI, 200);
            }
        }
    }
}

// -------------------------------------------------------
//  Promotion dialog
// -------------------------------------------------------

function showPromotionDialog(promos) {
    pendingPromotion = promos;
    const modal = document.getElementById('promotion-modal');
    const choices = document.getElementById('promotion-choices');
    choices.innerHTML = '';
    modal.style.display = 'flex';

    for (const mv of promos) {
        const btn = document.createElement('button');
        btn.className = 'promotion-btn';
        btn.textContent = PIECE_SYMBOLS[mv.promotion] || '';
        btn.addEventListener('click', () => {
            modal.style.display = 'none';
            pendingPromotion = null;
            executeMove(mv);
        });
        choices.appendChild(btn);
    }
}

// -------------------------------------------------------
//  AI
// -------------------------------------------------------

function _pickQueenPromo(move) {
    if (!move.promotion) return move;
    return game.getLegalMoves(game.turn)
        .filter(m => m.from[0]===move.from[0] && m.from[1]===move.from[1] &&
                     m.to[0]===move.to[0]     && m.to[1]===move.to[1])
        .find(m => m.promotion === (game.turn === WHITE ? PIECES.W_QUEEN : PIECES.B_QUEEN))
        || move;
}

function _updateAIPanel(nodes, depth, ms, move, score) {
    nodesCount.textContent   = nodes.toLocaleString();
    depthReached.textContent = depth;
    calcTime.textContent     = ms + 'ms';
    if (move) bestMoveDisplay.textContent =
        squareName(move.from[0], move.from[1]) + squareName(move.to[0], move.to[1]);
    // Mise à jour du score dans la barre d'évaluation
    if (score !== undefined) {
        const clamped = Math.max(-1000, Math.min(1000, score));
        const pct = 50 + (clamped / 1000) * 50;
        evalFill.style.backgroundPosition = `${100 - pct}% 0`;
        evalScore.textContent = score === 0 ? '0.0' : ((score > 0 ? '+' : '') + (score / 100).toFixed(1));
    }
}

function _onAIMoveReady(move, stats) {
    aiThinking.style.display = 'none';
    aiRunning = false;

    if (!move && !game.gameOver) {
        const fallback = game.getLegalMoves(game.turn);
        if (fallback.length > 0) move = fallback[0];
    }

    if (move) executeMove(_pickQueenPromo(move));
    _updateAIPanel(stats.nodes, stats.depth, stats.ms, move, stats.score);

    if (!game.gameOver && gameModeSelect.value === 'ai-vs-ai') {
        aiVsAiInterval = setTimeout(runAI, 300);
    }
}

async function runAI() {
    if (aiRunning || game.gameOver) return;
    aiRunning = true;
    aiThinking.style.display = 'flex';

    const timeLimitMs = parseInt(aiDepthSel.value);

    if (workerAvailable && aiWorker) {
        // --- Mode Worker : UI reste réactive pendant la recherche ---
        const state = game.cloneState();
        _workerTimer = setTimeout(_workerFallback, timeLimitMs + 4000);
        aiWorker.onmessage = ({ data }) => {
            clearTimeout(_workerTimer);
            _workerTimer = null;
            if (data.error) {
                _workerFallback();
                return;
            }
            _onAIMoveReady(data.move, {
                nodes: data.nodesEvaluated,
                depth: data.depthReached,
                ms:    data.calcTime,
                score: data.lastScore,
            });
        };
        aiWorker.postMessage({ type: 'search', state, timeLimitMs });
    } else {
        // --- Mode synchrone (fallback) ---
        await new Promise(resolve => setTimeout(resolve, 10));
        const move = ai.findBestMove(game, timeLimitMs);
        _onAIMoveReady(move, {
            nodes: ai.nodesEvaluated,
            depth: ai.depthReached,
            ms:    ai.calcTime,
            score: ai.lastScore,
        });
    }
}

// -------------------------------------------------------
//  Side panels
// -------------------------------------------------------

function updateSidePanels(moveResult) {
    // Status
    if (!game.gameOver) {
        const colorName = game.turn === WHITE ? 'Blancs' : 'Noirs';
        statusMsg.textContent = `Au tour des ${colorName}`;
        if (game.isInCheck(game.turn)) statusMsg.textContent += ' — Échec !';
        turnColorEl.className = game.turn === WHITE ? 'white-turn' : 'black-turn';
        turnColorEl.textContent = game.turn === WHITE ? '● Blancs' : '● Noirs';
    }

    // Evaluation bar
    const raw = evaluate(game);
    const clamped = Math.max(-1000, Math.min(1000, raw));
    const pct = 50 + (clamped / 1000) * 50;
    evalFill.style.backgroundPosition = `${100 - pct}% 0`;
    evalScore.textContent = raw === 0 ? '0.0' : ((raw > 0 ? '+' : '') + (raw / 100).toFixed(1));

    // Captured pieces — individual spans so flex-wrap works
    capturedWhite.innerHTML = game.capturedByWhite.map(p => `<span>${PIECE_SYMBOLS[p] || ''}</span>`).join('');
    capturedBlack.innerHTML = game.capturedByBlack.map(p => `<span>${PIECE_SYMBOLS[p] || ''}</span>`).join('');

    // Move history
    renderHistory();
}

function renderHistory() {
    historyList.innerHTML = '';
    const moves = game.moveList;
    for (let i = 0; i < moves.length; i += 2) {
        const row = document.createElement('div');
        row.className = 'history-move' + (i + 1 >= moves.length ? ' move-last' : '');
        const num = Math.floor(i / 2) + 1;
        row.innerHTML = `
            <span class="move-number">${num}.</span>
            <span class="move-white">${moves[i]?.san || ''}</span>
            <span class="move-black">${moves[i + 1]?.san || ''}</span>
        `;
        historyList.appendChild(row);
    }
    // Mark last move
    if (historyList.lastChild) historyList.lastChild.classList.add('move-last');
    historyList.scrollTop = historyList.scrollHeight;
}

// -------------------------------------------------------
//  Game over
// -------------------------------------------------------

function checkGameOver() {
    if (!game.gameOver) return;

    const modal = document.getElementById('game-over-modal');
    const title = document.getElementById('game-over-title');
    const msg   = document.getElementById('game-over-message');

    const res = game.gameResult;
    if (res.reason === 'checkmate') {
        const winner = res.winner === WHITE ? 'Blancs' : 'Noirs';
        title.textContent = `Échec et mat !`;
        msg.textContent   = `Les ${winner} gagnent !`;
    } else if (res.reason === 'stalemate') {
        title.textContent = 'Pat !';
        msg.textContent   = 'Match nul par pat.';
    } else if (res.reason === '50-move rule') {
        title.textContent = 'Match nul';
        msg.textContent   = 'Règle des 50 coups.';
    } else if (res.reason === 'insufficient material') {
        title.textContent = 'Match nul';
        msg.textContent   = 'Matériel insuffisant.';
    } else if (res.reason === 'resign') {
        const winner = res.winner === WHITE ? 'Blancs' : 'Noirs';
        title.textContent = 'Abandon';
        msg.textContent   = `Les ${winner} gagnent par abandon.`;
    }

    statusMsg.textContent = title.textContent;

    setTimeout(() => { modal.style.display = 'flex'; }, 600);
}

// -------------------------------------------------------
//  AI vs AI loop
// -------------------------------------------------------

function startAiVsAi() {
    stopAiVsAi();
    aiVsAiInterval = setTimeout(runAI, 300);
}

function stopAiVsAi() {
    if (aiVsAiInterval) { clearTimeout(aiVsAiInterval); aiVsAiInterval = null; }
}

// -------------------------------------------------------
//  Controls
// -------------------------------------------------------

function newGame() {
    stopAiVsAi();
    game.reset();
    ai = new ChessAI();
    ai.tt.clear(); // Vider la TT entre les parties
    selectedSquare = null;
    legalMovesCache = [];
    aiRunning = false;
    // Détacher le handler Worker pour éviter les réponses tardives
    if (aiWorker) aiWorker.onmessage = null;
    pendingPromotion = null;
    document.getElementById('game-over-modal').style.display = 'none';
    document.getElementById('promotion-modal').style.display = 'none';
    buildBoard();
    updateSidePanels({});
    statusMsg.textContent = 'Blanc commence';
    nodesCount.textContent = '0';
    depthReached.textContent = '0';
    calcTime.textContent = '0ms';
    bestMoveDisplay.textContent = '-';

    const mode = gameModeSelect.value;
    if (mode === 'ai-vs-ai') {
        startAiVsAi();
    } else if (mode === 'human-vs-ai') {
        const playerColor = playerColorSel.value;
        if (playerColor === BLACK) {
            setTimeout(runAI, 300);
        }
    }
}

document.getElementById('new-game-btn').addEventListener('click', newGame);

document.getElementById('undo-btn').addEventListener('click', () => {
    if (aiRunning) return;
    stopAiVsAi();
    const mode = gameModeSelect.value;
    // Undo two moves if human vs AI (undo AI's response too)
    game.undoMove();
    if (mode === 'human-vs-ai') game.undoMove();
    selectedSquare = null;
    legalMovesCache = [];
    renderPieces();
    updateSidePanels({});
});

document.getElementById('flip-board-btn').addEventListener('click', () => {
    boardFlipped = !boardFlipped;
    buildBoard();
    renderPieces();
    updateSidePanels({});
});

document.getElementById('resign-btn').addEventListener('click', () => {
    if (game.gameOver || aiRunning) return;
    const mode = gameModeSelect.value;
    if (mode === 'ai-vs-ai') return;

    // In human-vs-ai the human always resigns; in human-vs-human the current player resigns
    const resignColor = mode === 'human-vs-ai' ? playerColorSel.value : game.turn;
    stopAiVsAi();
    game.gameOver  = true;
    game.gameResult = { winner: resignColor === WHITE ? BLACK : WHITE, reason: 'resign' };
    statusMsg.textContent = 'Abandon';
    renderPieces();
    checkGameOver();
});

document.getElementById('game-over-new-game').addEventListener('click', newGame);

document.getElementById('load-fen-btn').addEventListener('click', () => {
    const fenInput = document.getElementById('fen-input');
    const fenError = document.getElementById('fen-error');
    const fen = fenInput.value.trim();
    if (!fen) return;

    try {
        stopAiVsAi();
        if (aiWorker) aiWorker.onmessage = null;
        game.loadFEN(fen);
        ai = new ChessAI();
        ai.tt.clear();
        selectedSquare = null;
        legalMovesCache = [];
        aiRunning = false;
        pendingPromotion = null;
        document.getElementById('game-over-modal').style.display = 'none';
        document.getElementById('promotion-modal').style.display = 'none';
        fenError.style.display = 'none';

        // Synchronise les sélecteurs de mode selon le choix IA
        const aiSide = document.getElementById('fen-ai-side').value;
        if (aiSide === 'both') {
            gameModeSelect.value = 'ai-vs-ai';
        } else if (aiSide === 'none') {
            gameModeSelect.value = 'human-vs-human';
        } else {
            gameModeSelect.value = 'human-vs-ai';
            // Le joueur humain est l'adversaire de l'IA
            playerColorSel.value = aiSide === 'black' ? 'white' : 'black';
        }

        buildBoard();
        updateSidePanels({});
        nodesCount.textContent = '0';
        depthReached.textContent = '0';
        calcTime.textContent = '0ms';
        bestMoveDisplay.textContent = '-';

        if (aiSide === 'both') {
            startAiVsAi();
        } else if (aiSide !== 'none') {
            // L'IA joue si c'est son tour
            if (game.turn === aiSide) setTimeout(runAI, 300);
        }
    } catch (err) {
        fenError.textContent = err.message;
        fenError.style.display = 'block';
    }
});

function exportPGN() {
    const mode = gameModeSelect.value;
    const playerColor = playerColorSel.value;
    let whiteName = 'Blancs', blackName = 'Noirs';
    if (mode === 'human-vs-ai') {
        whiteName = playerColor === WHITE ? 'Humain' : 'IA';
        blackName = playerColor === BLACK ? 'Humain' : 'IA';
    } else if (mode === 'ai-vs-ai') {
        whiteName = 'IA (Blancs)'; blackName = 'IA (Noirs)';
    }
    if (game.moveList.length === 0) return;
    const pgn = game.generatePGN({ whiteName, blackName });
    const blob = new Blob([pgn], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `partie_echecs_${new Date().toISOString().slice(0,10)}.pgn`;
    a.click();
    URL.revokeObjectURL(url);
}

document.getElementById('export-pgn-btn').addEventListener('click', exportPGN);
document.getElementById('export-pgn-controls-btn').addEventListener('click', exportPGN);

gameModeSelect.addEventListener('change', newGame);
playerColorSel.addEventListener('change', newGame);
aiDepthSel.addEventListener('change', () => { /* time limit read at search time */ });

// -------------------------------------------------------
//  Init
// -------------------------------------------------------
buildBoard();
updateSidePanels({});
