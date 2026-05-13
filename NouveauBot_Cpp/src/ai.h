#pragma once
#include "chess.h"
#include <chrono>
#include <atomic>
#include <cstring>
#include <vector>

// ─── Table de transposition ───────────────────────────────────────────────────
enum TTFlag : uint8_t { TT_EXACT=0, TT_LOWER=1, TT_UPPER=2 };

struct TTEntry {
    U64      hash{0};
    int      score{0};
    int8_t   depth{-1};
    TTFlag   flag{TT_EXACT};
    uint8_t  from{0}, to{0};
    Piece    promo{EMPTY};
};

constexpr int TT_SIZE = 1 << 22; // 4M entrées (~96 Mo sur le heap)

class TTable {
public:
    std::vector<TTEntry> entries;

    TTable() : entries(TT_SIZE) {}
    void  clear()  { std::fill(entries.begin(), entries.end(), TTEntry{}); }
    void  store(U64 h, int d, int sc, TTFlag fl, Move m);
    bool  probe(U64 h, int d, int alpha, int beta, int& score, Move& m) const;
    Move  bestMove(U64 h) const;
};

// ─── IA ───────────────────────────────────────────────────────────────────────
class ChessAI {
public:
    TTable  tt;
    int     nodes{0};
    int     depth{0};
    int     score{0};
    Move    bestMove{Move::null()};

    // timeLimitMs : temps max en millisecondes
    Move findBestMove(Position pos, int timeLimitMs = 1000);

private:
    std::chrono::time_point<std::chrono::steady_clock> startTime;
    int  timeLimit{1000};
    bool aborted{false};

    Move killers[64][2]{};
    int  history[12][64]{};

    int  negamax(Position& pos, int depth, int alpha, int beta, int ply, bool nullOk);
    int  qsearch (Position& pos, int alpha, int beta, int ply);

    int  scoreMove(const Position& pos, Move m, Move ttMove, int ply) const;

    bool timeUp() const;
    void resetSearchState();
};
