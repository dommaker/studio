/*
  Remove dependsOn column from WorkUnit table.
  Agent Loop rewrite (AS-025): dependsOn replaced by Agent LLM judgment + scope text.
*/
ALTER TABLE "work_unit" DROP COLUMN "dependsOn";
