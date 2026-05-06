// ============================================================
//  ai.worker.js  —  Web Worker autonome pour l'IA
//  Charge chess.js + ai.js via importScripts
//  (fonctionne avec un serveur local ou Firefox en file://)
// ============================================================

try {
    importScripts('chess.js', 'ai.js');
} catch (e) {
    // importScripts échoue avec Chrome en file:// — l'UI retombe sur le mode sync
    self.postMessage({ error: 'importScripts failed: ' + e.message });
}

self.onmessage = function ({ data }) {
    if (data.type !== 'search') return;

    const { state, timeLimitMs } = data;

    // Reconstruire un objet ChessGame minimal depuis l'état sérialisé
    const game = new ChessGame();
    game.board            = state.board.map(r => [...r]);
    game.turn             = state.turn;
    game.castlingRights   = { ...state.castlingRights };
    game.enPassantSquare  = state.enPassantSquare ? [...state.enPassantSquare] : null;
    game.halfMoveClock    = state.halfMoveClock;
    game.fullMoveNumber   = state.fullMoveNumber;
    game.gameOver         = false;
    game.gameResult       = null;
    game.history          = [];
    game.moveList         = [];
    game.capturedByWhite  = [];
    game.capturedByBlack  = [];

    const ai   = new ChessAI();
    const move = ai.findBestMove(game, timeLimitMs);

    self.postMessage({
        type:           'result',
        move,
        nodesEvaluated: ai.nodesEvaluated,
        calcTime:       ai.calcTime,
        lastScore:      ai.lastScore,
        depthReached:   ai.depthReached,
    });
};
