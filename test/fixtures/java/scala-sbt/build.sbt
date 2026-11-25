ThisBuild / scalaVersion := "3.9.0"
ThisBuild / organization := "rocketbrain.fixture"
ThisBuild / version := "1.0.0"
ThisBuild / semanticdbEnabled := true

lazy val core = project.in(file("core"))

lazy val app = project.in(file("app")).dependsOn(core).settings(
  libraryDependencies += "org.scalameta" %% "munit" % "1.2.1" % Test
)

lazy val root = project.in(file(".")).aggregate(core, app).settings(publish / skip := true)
