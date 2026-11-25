package scalafixture

class ApplicationSuite extends munit.FunSuite:
  test("calls cross-module Scala and Java declarations"):
    assertEquals(Application.greeting, "Scala greets Rocketbrain")

  test("selects the Int overload"):
    assertEquals(Application.count, "Scala counted 3")
