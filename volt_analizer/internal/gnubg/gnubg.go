package gnubg

import (
	"fmt"
	"io/fs"
)

type TanBoard _TanBoard

type MoveList interface {
	GetMovesNum() int
	GetMove(i int) Move
}

type Move interface {
	GetPlaysNum() int
	GetPlay(i int) [2]int
	GetEvalInfo() EvalInfo
	GetEquity() float32
	GetProbWin() float32
	GetProbWinG() float32
	GetProbWinBG() float32
	GetProbLose() float32
	GetProbLoseG() float32
	GetProbLoseBG() float32
}

type EvalInfo struct {
	Cubeful bool
	Plies   int
}

type CubeOptions struct {
	Cube      int    // Current cube value (1, 2, 4, ...); default 1
	CubeOwner int    // -1 = centered, 0 = player o, 1 = player x
	MatchTo   int    // 0 for money game, > 0 for match play
	Score     [2]int // [0] = score for o, [1] = score for x
	Crawford  bool   // Crawford game flag (match play)
	Jacoby    bool   // Jacoby rule flag (money game)
	Beavers   bool   // Beavers allowed flag (money game)
	Plies     int    // Evaluation plies 0..4; negative means "use default" (2)
	// ExactPlies заставляет пересчитать все возвращаемые ходы ровно на Plies.
	// Без него играет move filter GNU Backgammon: часть ходов отсеивается и
	// остаётся посчитанной на меньшей глубине, а при единственном кандидате
	// перебор прекращается досрочно.
	ExactPlies bool
	// MaxMoves ограничивает список ходов сверху (0 = без ограничения).
	// Используется вместе с ExactPlies, чтобы не досчитывать ходы,
	// которые всё равно не попадут в ответ.
	MaxMoves int
}

// normalizePlies приводит глубину перебора к поддерживаемому диапазону 0..4.
// Отрицательное значение означает "не задано" и превращается в 2 (обычная глубина GNU Backgammon).
func normalizePlies(n int) int {
	if n < 0 {
		return 2
	}
	if n > _MAX_FILTER_PLIES {
		return _MAX_FILTER_PLIES
	}
	return n
}

type CubeDecisionResult struct {
	Decision       CubeDecision
	OptimalEquity  float32
	NoDoubleEquity float32
	DoubleTakeEq   float32
	DoublePassEq   float32
	CubelessEquity float32
	ProbWin        float32
	ProbWinG       float32
	ProbWinBG      float32
	ProbLose       float32
	ProbLoseG      float32
	ProbLoseBG     float32
	Info           EvalInfo
}

func Init(dataDir fs.FS) error {
	initMatchEquity(dataDir, "met/Kazaross-XG2.xml")

	if err := evalInitialise(dataDir); err != nil {
		return fmt.Errorf("error in evalInitialise(): %v", err)
	}

	return nil
}

func Destroy() {
	evalShutdown()
}

func FindMoves(board TanBoard, dice [2]int, player int, scoreMoves bool, cubeful bool, opts ...CubeOptions) (MoveList, error) {

	if scoreMoves {
		var pml = _MoveList{}
		var aamf = &_MOVEFILTER_NORMAL
		var anBoard _TanBoard
		if player == 1 {
			anBoard = _TanBoard{board[1], board[0]}
		} else {
			anBoard = _TanBoard{board[0], board[1]}
		}
		var pci = &_CubeInfo{
			nCube:         1,
			fCubeOwner:    -1,
			fMove:         player,
			nMatchTo:      0,
			anScore:       [2]int{0, 0},
			fCrawford:     false,
			fJacoby:       true,
			fBeavers:      true,
			arGammonPrice: [4]float32{0, 0, 0, 0},
			bgv:           _VARIATION_STANDARD,
		}
		if len(opts) > 0 {
			o := opts[0]
			cube := o.Cube
			if cube < 1 {
				cube = 1
			}
			if err := setCubeInfo(
				pci,
				cube,
				o.CubeOwner,
				player,
				o.MatchTo,
				o.Score,
				o.Crawford,
				o.Jacoby,
				o.Beavers,
				_VARIATION_STANDARD,
			); err != nil {
				return nil, fmt.Errorf("error in setCubeInfo(): %v", err)
			}
		}
		var pec = &_EvalContext{
			fCubeful:       cubeful,
			nPlies:         2,
			fUsePrune:      true,
			fDeterministic: true,
			rNoise:         0,
		}
		if len(opts) > 0 {
			pec.nPlies = normalizePlies(opts[0].Plies)
		}
		if err := findnSaveBestMoves(&pml, dice[0], dice[1], anBoard, nil, 0, pci, pec, aamf); err != nil {
			return nil, err
		}
		if len(opts) > 0 && opts[0].ExactPlies && pec.nPlies > 0 {
			// Список отсортирован по equity: в ответ уйдут только первые MaxMoves,
			// поэтому остальные досчитывать на полной глубине незачем.
			if opts[0].MaxMoves > 0 && pml.cMoves > opts[0].MaxMoves {
				pml.cMoves = opts[0].MaxMoves
				pml.amMoves = pml.amMoves[:opts[0].MaxMoves]
			}
			if err := forceExactPlies(&pml, pci, pec, pec.nPlies); err != nil {
				return nil, err
			}
		}
		return pml, nil
	}

	{
		var tld = _ThreadLocalData{}
		var pml = _MoveList{}
		var anBoard _TanBoard
		if player == 1 {
			anBoard = _TanBoard{board[1], board[0]}
		} else {
			anBoard = _TanBoard{board[0], board[1]}
		}
		generateMoves(&tld, &pml, anBoard, dice[0], dice[1], false)

		return pml, nil
	}
}

// forceExactPlies пересчитывает все варианты списка ровно на nPlies и заново их сортирует.
//
// Нужен потому, что findnSaveBestMoves работает с move filter: ходы, отсеянные
// фильтром, остаются в списке с оценкой на меньшей глубине, а если фильтр оставил
// одного кандидата, перебор вообще прекращается досрочно (upstream: `goto finished`).
// Тогда evaluation.info.plies у ходов разного размера, а запрошенная глубина не достигается.
// Здесь эта гарантия восстанавливается (upstream делает то же самое для keyMove).
func forceExactPlies(pml *_MoveList, pci *_CubeInfo, pec *_EvalContext, nPlies int) error {
	var tld = _ThreadLocalData{}

	pml.rBestScore = -99999.9

	for i := 0; i < pml.cMoves; i++ {
		if pml.amMoves[i].esMove.ec.nPlies >= nPlies {
			continue
		}
		if err := scoreMove(&tld, nil, &pml.amMoves[i], pci, pec, nPlies); err != nil {
			return fmt.Errorf("error in scoreMove (exact plies): %v", err)
		}
		if pml.amMoves[i].rScore > pml.rBestScore {
			pml.iMoveBest = i
			pml.rBestScore = pml.amMoves[i].rScore
		}
	}

	sortMoves(pml.amMoves)
	pml.iMoveBest = 0

	return nil
}

func FindCubeDecision(board TanBoard, player int, opts CubeOptions) (*CubeDecisionResult, error) {
	var tld = _ThreadLocalData{}
	var anBoard _TanBoard
	if player == 1 {
		anBoard = _TanBoard{board[1], board[0]}
	} else {
		anBoard = _TanBoard{board[0], board[1]}
	}

	cube := opts.Cube
	if cube < 1 {
		cube = 1
	}

	var pci _CubeInfo
	if err := setCubeInfo(
		&pci,
		cube,
		opts.CubeOwner,
		player,
		opts.MatchTo,
		opts.Score,
		opts.Crawford,
		opts.Jacoby,
		opts.Beavers,
		_VARIATION_STANDARD,
	); err != nil {
		return nil, fmt.Errorf("error in setCubeInfo(): %v", err)
	}

	var pec = &_EvalContext{
		fCubeful:       true,
		nPlies:         normalizePlies(opts.Plies),
		fUsePrune:      true,
		fDeterministic: true,
		rNoise:         0,
	}

	var aarOutput [2][_NUM_ROLLOUT_OUTPUTS]float32
	if err := generalCubeDecisionE(&tld, nil, &aarOutput, anBoard, &pci, pec); err != nil {
		return nil, fmt.Errorf("error in generalCubeDecisionE(): %v", err)
	}

	var arDouble [_NUM_CUBEFUL_OUTPUTS]float32
	cd := findCubeDecision(&arDouble, &aarOutput, &pci)

	return &CubeDecisionResult{
		Decision:       cd,
		OptimalEquity:  arDouble[_OUTPUT_OPTIMAL],
		NoDoubleEquity: arDouble[_OUTPUT_NODOUBLE],
		DoubleTakeEq:   arDouble[_OUTPUT_TAKE],
		DoublePassEq:   arDouble[_OUTPUT_DROP],
		CubelessEquity: aarOutput[0][_OUTPUT_EQUITY],
		ProbWin:        aarOutput[0][_OUTPUT_WIN],
		ProbWinG:       aarOutput[0][_OUTPUT_WINGAMMON],
		ProbWinBG:      aarOutput[0][_OUTPUT_WINBACKGAMMON],
		ProbLose:       1.0 - aarOutput[0][_OUTPUT_WIN],
		ProbLoseG:      aarOutput[0][_OUTPUT_LOSEGAMMON],
		ProbLoseBG:     aarOutput[0][_OUTPUT_LOSEBACKGAMMON],
		Info: EvalInfo{
			Cubeful: true,
			Plies:   normalizePlies(opts.Plies),
		},
	}, nil
}
