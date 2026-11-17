'use strict';

// Original test data, created only in a new disposable local MariaDB datadir.
module.exports = `
CREATE DATABASE rocketbrain_fixture CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rocketbrain_fixture;
CREATE TABLE departments (id INT PRIMARY KEY, name VARCHAR(80) NOT NULL);
CREATE TABLE people (
  id BIGINT UNSIGNED PRIMARY KEY,
  department_id INT NULL,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(180) NULL,
  status ENUM('new','active','closed') NOT NULL DEFAULT 'new',
  amount DECIMAL(24,8) NOT NULL DEFAULT 0,
  details JSON NULL,
  payload BLOB NULL,
  created_at DATETIME(6) NOT NULL,
  name_length INT GENERATED ALWAYS AS (CHAR_LENGTH(name)) STORED,
  UNIQUE KEY uq_people_email (email),
  KEY ix_people_status_name (status, name),
  CONSTRAINT fk_people_department FOREIGN KEY (department_id) REFERENCES departments(id)
);
CREATE TABLE memberships (person_id BIGINT UNSIGNED NOT NULL, department_id INT NOT NULL, role VARCHAR(50), PRIMARY KEY (person_id, department_id));
CREATE TABLE transaction_probe (id INT PRIMARY KEY, value_text VARCHAR(100) NOT NULL, version INT NOT NULL DEFAULT 0);
CREATE TABLE audit_probe (id INT AUTO_INCREMENT PRIMARY KEY, person_id BIGINT UNSIGNED, action_name VARCHAR(20));
CREATE TABLE \`order\` (id INT PRIMARY KEY, \`select\` VARCHAR(80));
CREATE TABLE \`한글_테이블\` (id INT PRIMARY KEY, \`값\` VARCHAR(100));
INSERT INTO departments VALUES (1,'Engineering'),(2,'데이터');
INSERT INTO people(id,department_id,name,email,status,amount,details,payload,created_at) VALUES
 (1,1,'Alex Kim','alex@example.test','active',1234567890123456.12345678,'{"locale":"ko-KR","enabled":true}',X'00CAFEFF','2026-11-12 12:34:56.123456'),
 (2,2,'한글 이름',NULL,'new',-12.50000000,NULL,NULL,'2026-11-12 00:00:00.000001'),
 (9007199254740993,NULL,'<img src=x onerror=alert(1)>','html@example.test','closed',0,'{"text":"a,b"}',X'000A0D','2026-11-12 01:02:03.000000');
INSERT INTO memberships VALUES (1,1,'owner'),(2,2,'reader');
INSERT INTO transaction_probe VALUES (1,'original',0),(2,'second',0);
INSERT INTO \`order\` VALUES (1,'quoted identifier');
INSERT INTO \`한글_테이블\` VALUES (1,'오프라인 테스트');
CREATE VIEW active_people AS SELECT id,name,department_id FROM people WHERE status='active';
CREATE PROCEDURE fixture_people_count() SELECT COUNT(*) AS people_count FROM people;
CREATE TRIGGER people_after_update AFTER UPDATE ON people FOR EACH ROW INSERT INTO audit_probe(person_id,action_name) VALUES(NEW.id,'update');
`;
