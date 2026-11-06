all: TB-Auto-Select-Latest-Message.xpi
clean: ; -rm -f TB-Auto-Select-Latest-Message.xpi

version=$(shell grep -o '"version"\s*:\s*"\S*"' manifest.json | sed -e 's/.*"\([0-9].*\)".*/\1/')

CMD=find . \( \( -name RCS -o -name .svn -o -name .git \) -prune \) -o \
	\! -name .gitignore \
	\! -name '*~' \
	\! -name '.\#*' \
	\! -name '*,v' \
	\! -name Makefile \
	\! -name '*.xpi' \
	\! -name '\#*' \
	\! -name '*.pl' \
	\! -name '\.*.js' \
	\! -name '*README.md' \
	\! -iname '.ds_store' \
	\! \( -path '*/.git/*' -or -path '*/.vscode/*' \) \
	-type f -print
FILES=$(shell $(CMD))

TB-Auto-Select-Latest-Message.xpi: $(FILES)
	rm -f $@.tmp
	zip -r $@.tmp $(FILES)
	mv $@.tmp $@

release/TB-Auto-Select-Latest-Message-${version}.xpi: TB-Auto-Select-Latest-Message.xpi
	mkdir -p "`dirname $@`"
	cp TB-Auto-Select-Latest-Message.xpi "$@"

release: release/TB-Auto-Select-Latest-Message-${version}.xpi
