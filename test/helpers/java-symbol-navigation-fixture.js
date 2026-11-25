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
    public String alternative() { return renderer.render("other"); }
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

function usageSources(namespace,tag) {
  const type = 'Service'+tag, caller = 'Calls'+tag, fqn = namespace+'.'+type, property = 'rocketbrain.usage-'+tag.toLowerCase()+'.label';
  const withDefault = '${'+property+':default}', placeholder = '${'+property+'}';
  const files = {
    [type+'.java']:`package ${namespace};\nimport org.springframework.beans.factory.annotation.Value;\nimport org.springframework.stereotype.Component;\n@Component public class ${type} {\n  @Value("${withDefault}") private String label;\n  public String echo(int value) { return label + value; }\n  public String echo(String value) { return value; }\n  public String own() { return echo(2); }\n  public void setLabel(String value) { this.label = value; }\n}\n`,
    [caller+'.java']:`package ${namespace};\npublic class ${caller} {\n  public String use(${type} service) { return service.echo(42); }\n  public String other(${type} service) { return service.echo("wrong"); }\n}\n`,
    ['spring-usage-'+tag+'.xml']:`<?xml version="1.0"?>\n<beans xmlns="http://www.springframework.org/schema/beans"\n    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n    xsi:schemaLocation="http://www.springframework.org/schema/beans https://www.springframework.org/schema/beans/spring-beans.xsd">\n  <bean id="linked" class="${fqn}">\n    <property name="label" value="${placeholder}"/>\n  </bean>\n  <!-- <bean class="${fqn}"/> -->\n  <bean id="string" class="java.lang.String">\n    <constructor-arg value="${fqn}"/>\n  </bean>\n</beans>\n`,
    ['application-usage-'+tag+'.properties']:`# ${property} is documented here\n${property}=fixture\n${property}-extra=irrelevant\n`
  };
  return {type,caller,fqn,property,files};
}

module.exports = { javaNavigationFixture,kotlinExtensionSources,usageSources };
