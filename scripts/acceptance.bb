#!/usr/bin/env bb
(require '[babashka.fs :as fs]
         '[babashka.process :as process]
         '[cheshire.core :as json])

(fs/create-dirs "./tmp")
(def features ["translation-agent" "typescript-toolchain" "typescript-worker" "typescript-extension"])
(def sources
  (mapv (fn [stem]
          (let [feature (str "docs/acceptance/" stem ".feature")
                output (str "./tmp/" stem ".json")]
            (process/check (process/shell "gherkin-parser" feature output))
            {:path feature :ir (json/parse-string (slurp output) true)}))
        features))

;; Generate concrete scenarios from APS IR, then execute them through the
;; Cucumber adapter. Original data tables/tags are retained by its official AST.
(spit "./tmp/acceptance-sources.json" (json/generate-string sources))
(process/check (process/shell "node" "--import" "tsx" "scripts/generate-acceptance.ts"))
(process/check (process/shell "node" "--import" "tsx" "./tmp/acceptance-runner.ts"))
