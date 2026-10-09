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

;; APS IR drives the generated executable's selected scenarios and expected count.
;; Cucumber is the runner adapter and retains original data-table arguments:
;; the APS IR currently omits those arguments. No project Gherkin parser is used.
(spit "./tmp/acceptance-runner.ts"
      (str "import { runAcceptance } from '../features/runtime.ts';\n"
           "await runAcceptance(" (json/generate-string sources) ");\n"))
(process/check (process/shell "node" "--import" "tsx" "./tmp/acceptance-runner.ts"))
