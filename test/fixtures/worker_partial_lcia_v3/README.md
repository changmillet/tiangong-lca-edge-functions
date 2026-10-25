# Native Worker partial LCIA fixture

These synthetic files were emitted by the actual Worker CalculationBundleWriter and all-unit query encoder through `calculation_bundle::tests::partial_bundle_keeps_inventory_and_explicit_unavailable_rows`. They contain one available known-zero category, one unavailable category, and retained inventory; no real Process or production execution is represented.

To regenerate, run the Worker test with `WORKER_LCIA_PARTIAL_CONSUMER_FIXTURE_DIR` set to a new absolute directory, then compare/copy its files here. The test refuses existing output directories. The exact method identifiers are fixed test-axis identities; their fake fixture factors/results do not qualify the real scientific methods.

Edge tests read these bytes rather than rebuilding equivalent JSON by hand, so producer serializer/schema drift is visible. Existing historical v2 fixtures remain independent.
