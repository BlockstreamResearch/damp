TEX := main.tex
APPENDIX := appendix-code.tex
AUDIT_SOURCE := ../../simf/lib/audit.simf
VERIFIER_SOURCE := ../../simf/verifier_d4.simf
OUT_DIR := out
PDF := $(OUT_DIR)/main.pdf
LATEXMK := latexmk
LATEXMK_FLAGS := -xelatex -outdir=$(OUT_DIR) -interaction=nonstopmode -halt-on-error -file-line-error

.PHONY: all pdf watch clean distclean

all: pdf

pdf: $(PDF)

$(OUT_DIR):
	mkdir -p $(OUT_DIR)

$(PDF): $(TEX) $(APPENDIX) $(AUDIT_SOURCE) $(VERIFIER_SOURCE) references.bib | $(OUT_DIR)
	$(LATEXMK) $(LATEXMK_FLAGS) $(TEX)

watch: | $(OUT_DIR)
	$(LATEXMK) $(LATEXMK_FLAGS) -pvc $(TEX)

clean:
	if [ -d "$(OUT_DIR)" ]; then $(LATEXMK) $(LATEXMK_FLAGS) -c $(TEX); fi
	rm -f $(OUT_DIR)/main.bbl $(OUT_DIR)/main.blg $(OUT_DIR)/main.xdv

distclean:
	if [ -d "$(OUT_DIR)" ]; then $(LATEXMK) $(LATEXMK_FLAGS) -C $(TEX); fi
	rm -rf $(OUT_DIR)
