.PHONY: all damp pgc clean distclean

all: damp pgc

damp:
	$(MAKE) -C damp

pgc:
	$(MAKE) -C pgc

clean:
	$(MAKE) -C damp clean
	$(MAKE) -C pgc clean

distclean:
	$(MAKE) -C damp distclean
	$(MAKE) -C pgc distclean
