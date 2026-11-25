package scalafixture

object Application:
  def greeting: String = Message.hello(JavaPrefix.name())
  def count: String = Message.hello(3)

  def main(args: Array[String]): Unit =
    println(greeting + " / " + count)
