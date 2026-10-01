-- Проекты как часть GTD: результат из нескольких шагов, у которого есть следующее действие.
--
-- До сих пор «проект» был свободной строкой `list_name` на каждом деле: имена расходились
-- («Работа», «Работа · Яндекс»), у личных дел «Переезд» имя пропадало с доски под сферой, а закрыть
-- или переименовать проект целиком было нечем. Проект теперь запись `shared_tasks` с `kind='project'`:
-- она наследует области доступа, версии, аудит и идемпотентность, и второго слоя авторизации не нужно.
-- Дела и идеи ссылаются на проект через `project_id`. `list_name` остаётся в таблице для отката образа,
-- но источником правды больше не служит.

-- Ключ имени: регистр, «ё», пробелы и разделитель вложенности « · ». Тождество, а не смысл: какой из
-- похожих проектов подходит, решает агент. Одна функция на SQL и на код, чтобы ключи не расходились.
CREATE FUNCTION task_project_key(title text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT btrim(regexp_replace(regexp_replace(replace(lower(title), 'ё', 'е'), '\s*·\s*', ' · ', 'g'), '\s+', ' ', 'g')) $$;

-- Название для показа: тот же порядок пробелов и разделителя, регистр человека остаётся.
CREATE FUNCTION task_project_title(title text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT btrim(regexp_replace(regexp_replace(title, '\s*·\s*', ' · ', 'g'), '\s+', ' ', 'g')) $$;

ALTER TABLE shared_tasks
  DROP CONSTRAINT shared_tasks_kind_check,
  ADD CONSTRAINT shared_tasks_kind_check CHECK (kind IN ('task', 'idea', 'ritual', 'project'));

ALTER TABLE shared_tasks
  ADD COLUMN project_id uuid REFERENCES shared_tasks(id) ON DELETE SET NULL;

CREATE INDEX shared_tasks_project ON shared_tasks(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE shared_tasks
  -- Проект принят автором сразу, ничьим и предложенным не бывает, сам в проект не входит и не повторяется.
  -- Срока у проекта нет: `shared_tasks_ideas_without_deadline` уже требует его для любого не-task.
  ADD CONSTRAINT shared_tasks_project_shape CHECK (
    kind <> 'project' OR (
      status IN ('accepted', 'completed', 'cancelled')
      AND assignee_telegram_id = creator_telegram_id
      AND project_id IS NULL
      AND recurrence_unit IS NULL
      AND pending_assignee_telegram_id IS NULL
    )
  ),
  -- В проекте лежат дела и идеи; традиция живёт сама по себе.
  ADD CONSTRAINT shared_tasks_in_project_kind CHECK (project_id IS NULL OR kind IN ('task', 'idea'));

-- Дело и его проект принадлежат одной области: семья, группа, пространство. Личный проект один у своего
-- человека. Без этого триггера ссылка могла бы утащить дело в чужой проект.
CREATE FUNCTION guard_shared_task_project() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.project_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM shared_tasks p
     WHERE p.id = NEW.project_id
       AND p.kind = 'project'
       AND p.family_id = NEW.family_id
       AND p.scope = NEW.scope
       AND p.group_id IS NOT DISTINCT FROM NEW.group_id
       AND p.space_id IS NOT DISTINCT FROM NEW.space_id
       AND (NEW.scope <> 'personal' OR p.creator_telegram_id = NEW.assignee_telegram_id)
  ) THEN
    RAISE EXCEPTION 'AGENT_TASK_PROJECT_SCOPE_MISMATCH';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shared_task_project_guard
  BEFORE INSERT OR UPDATE OF project_id ON shared_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_shared_task_project();

-- Живой проект с таким именем в области один: тождество имени держит и база, а не только код.
CREATE UNIQUE INDEX shared_tasks_active_project_title ON shared_tasks (
  family_id, scope,
  COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid),
  (CASE WHEN scope = 'personal' THEN creator_telegram_id ELSE '' END),
  task_project_key(title)
) WHERE kind = 'project' AND status = 'accepted';

-- Перенос: каждое различное имя списка в области становится проектом, дела получают ссылку.
-- Личные списки у каждого свои, семейные и групповые общие. Название берётся из написаний с
-- прописной буквы, при равенстве из самого раннего; сфера только когда она одна у всех дел списка.
-- «Работа» и «Работа · Яндекс» остаются двумя проектами: вложенность по имени это договорённость
-- людей, а не данные, и сливать их решает агент вместе с человеком.
INSERT INTO shared_tasks (
  family_id, group_id, scope, creator_telegram_id, assignee_telegram_id, title,
  status, kind, space_id, life_area, created_at, updated_at
)
SELECT family_id, group_id, scope, creator, creator, title,
       'accepted', 'project', space_id, life_area, first_at, first_at
  FROM (
    SELECT t.family_id, t.group_id, t.scope, t.space_id,
           (CASE WHEN t.scope = 'personal' THEN t.assignee_telegram_id ELSE '' END) AS owner,
           task_project_key(t.list_name) AS key,
           (array_agg(task_project_title(t.list_name)
              ORDER BY (left(t.list_name, 1) <> lower(left(t.list_name, 1))) DESC, t.created_at, t.id))[1] AS title,
           (array_agg(t.creator_telegram_id ORDER BY t.created_at, t.id))[1] AS creator,
           CASE WHEN count(*) = count(t.life_area) AND count(DISTINCT t.life_area) = 1
                THEN min(t.life_area) END AS life_area,
           min(t.created_at) AS first_at
      FROM shared_tasks t
     WHERE t.list_name IS NOT NULL AND t.kind IN ('task', 'idea')
     GROUP BY t.family_id, t.group_id, t.scope, t.space_id,
              (CASE WHEN t.scope = 'personal' THEN t.assignee_telegram_id ELSE '' END),
              task_project_key(t.list_name)
  ) grouped;

UPDATE shared_tasks t
   SET project_id = p.id
  FROM shared_tasks p
 WHERE p.kind = 'project'
   AND t.kind IN ('task', 'idea')
   AND t.list_name IS NOT NULL
   AND t.project_id IS NULL
   AND p.family_id = t.family_id
   AND p.scope = t.scope
   AND p.group_id IS NOT DISTINCT FROM t.group_id
   AND p.space_id IS NOT DISTINCT FROM t.space_id
   AND task_project_key(p.title) = task_project_key(t.list_name)
   AND (t.scope <> 'personal' OR p.creator_telegram_id = t.assignee_telegram_id);
