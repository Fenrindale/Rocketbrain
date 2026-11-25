'use strict';

function javaNavigationFixture(namespace) {
  const sources = {
    Renderer: `public interface Renderer {
    String render(int value);
    String render(String value);
}`,
    BaseRenderer: `public class BaseRenderer implements Renderer {
    @Override public String render(int value) { return "base:" + value; }
    @Override public String render(String value) { return "base:" + value; }
}`,
    FirstRenderer: `public final class FirstRenderer extends BaseRenderer {
    @Override public String render(int value) { return "first:" + value; }
    @Override public String render(String value) { return "first:" + value; }
}`,
    SecondRenderer: `public final class SecondRenderer implements Renderer {
    @Override public String render(int value) { return "second:" + value; }
    @Override public String render(String value) { return "second:" + value; }
}`,
    Navigator: `public final class Navigator {
    private final Renderer renderer = new FirstRenderer();
    public String run() { return renderer.render(42); }
    public String jdk() { return Integer.toHexString(42); }
    public static void main(String[] args) { System.out.print(new Navigator().run()); }
}`
  };
  return Object.fromEntries(Object.entries(sources).map(([name,body]) => [name,`package ${namespace};\n\n${body}\n`]));
}

function kotlinExtensionSources() {
  return {
    'InvoiceExtension.kt': 'package editor.fixture\n\nfun Invoice.ticketLabel(): String = "invoice:" + number\n',
    'StringExtension.kt': 'package editor.fixture\n\nfun String.ticketLabel(): String = "string:" + this\n',
    'ExtensionCaller.kt': 'package editor.fixture\n\nfun display(invoice: Invoice): String = invoice.ticketLabel()\nfun display(value: String): String = value.ticketLabel()\n'
  };
}

module.exports = { javaNavigationFixture,kotlinExtensionSources };
