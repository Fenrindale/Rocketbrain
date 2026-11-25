package scalafixture

object Message:
  def hello(name: String): String = s"Scala greets $name"
  def hello(number: Int): String = s"Scala counted $number"
