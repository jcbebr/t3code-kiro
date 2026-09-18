# Bundled SPDX templates

These files contain the `licenseId` and `licenseText` fields from SPDX License List
v3.28.0, pinned to revision
[`c4a7237ec8f4654e867546f9f409749300f1bf4c`](https://github.com/spdx/license-list-data/tree/c4a7237ec8f4654e867546f9f409749300f1bf4c/json/details).
License text is unchanged apart from trimming surrounding whitespace, matching
the generator's existing cache format.

The fork ships the templates used by `third-party-licenses.config.json` so a fresh
build does not need to reach `raw.githubusercontent.com`. Package and asset
attribution is still collected by the generator. When changing the pinned SPDX
version or adding a generated license, update these templates from the same
pinned revision.
