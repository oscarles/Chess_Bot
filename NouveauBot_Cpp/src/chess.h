#pragma once
#include <cstdint>
#include <vector>
#include <string>

// ─── Types de base ───────────────────────────────────────────────────────────
using U64 = uint64_t;

// Cases : A1=0 … H8=63.   rank = sq/8 (0=rang1)   file = sq%8 (0=colA)
enum Color { WHITE=0, BLACK=1 };
enum PType { PAWN=0, KNIGHT, BISHOP, ROOK, QUEEN, KING, NO_PT };

// Pièce : 0-5 = blanches, 6-11 = noires, 12 = vide
enum Piece {
    W_PAWN=0, W_KNIGHT, W_BISHOP, W_ROOK, W_QUEEN, W_KING,
    B_PAWN=6, B_KNIGHT, B_BISHOP, B_ROOK, B_QUEEN, B_KING,
    EMPTY=12
};

constexpr Color colorOf(Piece p) { return (Color)(p / 6); }
constexpr PType typeOf (Piece p) { return p == EMPTY ? NO_PT : (PType)(p % 6); }
constexpr Piece mkPiece(Color c, PType t) { return (Piece)(c * 6 + (int)t); }

// ─── Coup ─────────────────────────────────────────────────────────────────────
struct Move {
    int8_t from{0}, to{0};
    Piece  piece{EMPTY}, captured{EMPTY}, promo{EMPTY};
    bool   castling{false}, enPassant{false}, doublePush{false};

    bool valid()       const { return piece != EMPTY; }
    static Move null()       { return {}; }
};
inline bool movesEq(Move a, Move b) {
    return a.from == b.from && a.to == b.to && a.promo == b.promo;
}

// Info pour défaire un coup
struct UndoInfo {
    uint8_t castling;
    int8_t  epFile;    // -1 si pas de prise en passant
    uint8_t halfmove;
    U64     zobrist;
};

// ─── Constantes bitboard ──────────────────────────────────────────────────────
constexpr U64 FILE_A = 0x0101010101010101ULL;
constexpr U64 FILE_H = 0x8080808080808080ULL;
constexpr U64 RANK_1 = 0x00000000000000FFULL;
constexpr U64 RANK_2 = RANK_1 << 8;
constexpr U64 RANK_4 = RANK_1 << 24;
constexpr U64 RANK_5 = RANK_1 << 32;
constexpr U64 RANK_7 = RANK_1 << 48;
constexpr U64 RANK_8 = RANK_1 << 56;

// ─── Tables d'attaques pré-calculées ──────────────────────────────────────────
extern U64 KNIGHT_ATK[64];
extern U64 KING_ATK[64];
extern U64 PAWN_ATK[2][64];

void initTables();   // à appeler une fois au démarrage

// Attaques des pièces glissantes (calculées à la volée)
U64 rookAttacks  (int sq, U64 occ);
U64 bishopAttacks(int sq, U64 occ);
inline U64 queenAttacks(int sq, U64 occ) {
    return rookAttacks(sq, occ) | bishopAttacks(sq, occ);
}

// ─── Zobrist ──────────────────────────────────────────────────────────────────
extern U64 ZB_PC[12][64], ZB_SIDE, ZB_CAST[16], ZB_EP[8];

// ─── Utilitaires bitboard ─────────────────────────────────────────────────────
inline int lsb (U64 b) { return __builtin_ctzll(b); }
inline int pop (U64& b) { int s = lsb(b); b &= b - 1; return s; }
inline int popcnt(U64 b) { return __builtin_popcountll(b); }

// ─── Position ────────────────────────────────────────────────────────────────
class Position {
public:
    U64     bb[12]{};       // bitboard par pièce
    uint8_t bd[64]{};       // bd[case] = Piece (12 = vide)
    U64     white{}, black{}, occ{};

    bool    wtm{true};      // blancs au trait
    uint8_t castling{0};    // bit0=wK bit1=wQ bit2=bK bit3=bQ
    int8_t  epFile{-1};     // -1 si pas d'en-passant
    uint8_t halfmove{0};
    int     fullmove{1};
    U64     zobrist{0};
    int     material{0};    // matériel blanc − noir (en centipions)

    Position();
    void reset();
    void fromFen(const std::string& fen);

    std::vector<Move> genMoves()    const;
    std::vector<Move> genCaptures() const;

    UndoInfo doMove  (Move m);
    void     undoMove(Move m, UndoInfo u);

    bool inCheck()                  const;
    bool attacked(int sq, Color by) const;

    Color side() const { return wtm ? WHITE : BLACK; }
    Color them() const { return wtm ? BLACK : WHITE; }

    int eval() const;

private:
    void put   (int sq, Piece p);
    void remove(int sq);
    void rehash();

    void genPawnMoves (std::vector<Move>&, bool captOnly) const;
    void genPieceMoves(std::vector<Move>&, bool captOnly) const;
    void genKingMoves (std::vector<Move>&, bool captOnly) const;
};
