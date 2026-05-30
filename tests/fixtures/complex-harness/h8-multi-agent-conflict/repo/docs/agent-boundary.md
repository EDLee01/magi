# Parallel worker claims

Workers may claim disjoint files before editing. A same-file claim must be
rejected so two workers do not concurrently own the same write target.
