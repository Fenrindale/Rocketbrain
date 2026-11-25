package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import java.util.regex.Pattern;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.*;
import static rocketbrain.signature.SignatureInspector.object;

/** File Structure declarations and effective members from the compiler's attributed trees. */
final class StructureInspector {
    private static final int MAX_RESULTS = 500;
    private static final Set<String> TYPE_KEYWORDS = Set.of("class","interface","enum","record");
    private static final Pattern TOKENS = Pattern.compile(
        "\\s+|//[^\\r\\n]*|/\\*[\\s\\S]*?\\*/|\"\"\"[\\s\\S]*?\"\"\"|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" +
        "|\\p{javaJavaIdentifierStart}\\p{javaJavaIdentifierPart}*|.", Pattern.DOTALL);
    private final Trees trees;
    private final SourcePositions positions;
    private final Elements elements;
    private final Types types;
    private final Map<String, SignatureInspector.Source> sources;

    private record Span(int start, int end) {}
    private record Token(String text, Span span) {}
    private record Declaration(TypeElement type, Span bounds, Span selection, String label, String detail) {}

    StructureInspector(JavacTask task, Map<String, SignatureInspector.Source> sources) {
        trees = Trees.instance(task);
        positions = trees.getSourcePositions();
        elements = task.getElements();
        types = task.getTypes();
        this.sources = sources;
    }

    Map<String,Object> inspect(CompilationUnitTree unit, int offset, String group) {
        List<Declaration> declarations = declarations(unit);
        Declaration current = declarations.stream().filter(item -> item.bounds.start <= offset && offset < item.bounds.end)
            .min(Comparator.comparingInt(item -> item.bounds.end - item.bounds.start)).orElse(null);
        if (group.equals("nested")) {
            List<Declaration> nested = declarations.stream().filter(item -> item.type.getNestingKind().isNested()).toList();
            String uri = unit.getSourceFile().toUri().toString();
            List<Map<String,Object>> rows = nested.stream().limit(MAX_RESULTS).map(item -> row(item.label,
                kind(item.type.getKind()),"",item.detail,owner(item.type.getEnclosingElement()),uri,item.selection,item == current,
                item.type.getNestingKind().name())).toList();
            return object("members",rows,"limited",nested.size() > MAX_RESULTS);
        }
        TypeElement selected;
        if (current != null) selected = current.type;
        else {
            List<Declaration> top = declarations.stream().filter(item -> !item.type.getNestingKind().isNested()).toList();
            if (top.size() == 1) selected = top.get(0).type;
            else return object("error","Place the caret in the Java type to inspect its inherited members.");
        }
        DeclaredType receiver = (DeclaredType)selected.asType();
        List<? extends Element> inherited = elements.getAllMembers(selected).stream()
            .filter(member -> !member.getEnclosingElement().equals(selected) && visibleKind(member.getKind())
                && !member.getModifiers().contains(Modifier.PRIVATE))
            .filter(member -> selected.getEnclosedElements().stream().noneMatch(own ->
                visibleKind(own.getKind()) && own.getSimpleName().equals(member.getSimpleName()) &&
                (elements.hides(own,member) || own instanceof ExecutableElement method &&
                    member instanceof ExecutableElement overridden && elements.overrides(method,overridden,selected))))
            .sorted(Comparator.comparing((Element item) -> item.getSimpleName().toString())
                .thenComparing(item -> owner(item.getEnclosingElement())).thenComparing(Object::toString)).toList();
        List<Map<String,Object>> rows = new ArrayList<>();
        for (Element member : inherited.stream().limit(MAX_RESULTS).toList()) {
            TypeMirror applied = types.asMemberOf(receiver,member);
            String signature = "", detail = applied.toString();
            if (applied instanceof ExecutableType method) {
                signature = "(" + String.join(", ",method.getParameterTypes().stream().map(Object::toString).toList()) + ")";
                detail = method.getReturnType().toString();
            }
            TreePath path = trees.getPath(member);
            String uri = path == null ? null : path.getCompilationUnit().getSourceFile().toUri().toString();
            Span selection = path == null ? null : namedSelection(path,member.getSimpleName().toString());
            rows.add(row(member.getSimpleName().toString(),kind(member.getKind()),signature,detail,
                owner(member.getEnclosingElement()),uri,selection,false,"INHERITED"));
        }
        return object("type",owner(selected),"members",rows,"limited",inherited.size() > MAX_RESULTS);
    }

    private List<Declaration> declarations(CompilationUnitTree unit) {
        List<Declaration> result = new ArrayList<>();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitClass(ClassTree tree, Void unused) {
                TreePath path = getCurrentPath();
                if (trees.getElement(path) instanceof TypeElement type) {
                    Span bounds = span(unit,tree);
                    String label = type.getSimpleName().toString();
                    Span selection = namedSelection(path,label);
                    String detail = switch (type.getNestingKind()) {
                        case MEMBER -> "Member type";
                        case LOCAL -> "Local type";
                        default -> "";
                    };
                    TreePath parent = path.getParentPath();
                    if (type.getNestingKind() == NestingKind.ANONYMOUS && parent.getLeaf() instanceof NewClassTree creation &&
                        creation.getClassBody() == tree) {
                        Tree reference = creation.getIdentifier();
                        selection = span(unit,reference);
                        bounds = span(unit,creation);
                        TypeMirror base = trees.getTypeMirror(new TreePath(parent,reference));
                        String baseLabel = base instanceof DeclaredType declared ?
                            declared.asElement().getSimpleName().toString() : reference.toString();
                        label = "Anonymous " + baseLabel;
                        detail = "Anonymous implementation of " + base;
                    }
                    if (bounds != null) result.add(new Declaration(type,bounds,selection,label,detail));
                }
                return super.visitClass(tree,unused);
            }
        }.scan(unit,null);
        return result;
    }

    private static boolean visibleKind(ElementKind kind) {
        return kind.isClass() || kind.isInterface() || kind == ElementKind.METHOD ||
            kind == ElementKind.FIELD || kind == ElementKind.ENUM_CONSTANT;
    }

    private static String kind(ElementKind kind) {
        return switch (kind) {
            case ANNOTATION_TYPE -> "Annotation";
            case ENUM_CONSTANT -> "Enum member";
            default -> kind.name().substring(0,1) + kind.name().substring(1).toLowerCase(Locale.ROOT);
        };
    }

    private String owner(Element element) {
        if (element == null) return "";
        if (element instanceof TypeElement type && !type.getQualifiedName().isEmpty() &&
            !type.getNestingKind().equals(NestingKind.LOCAL)) return type.getQualifiedName().toString();
        if (element instanceof PackageElement pack) return pack.getQualifiedName().toString();
        String name = element instanceof TypeElement type && type.getNestingKind() == NestingKind.ANONYMOUS ?
            "<anonymous>" : element.getSimpleName().toString();
        if (element instanceof ExecutableElement method) name += "(" +
            String.join(", ",method.getParameters().stream().map(parameter -> parameter.asType().toString()).toList()) + ")";
        String enclosing = owner(element.getEnclosingElement());
        return enclosing.isEmpty() ? name : enclosing + " › " + name;
    }

    private static Map<String,Object> row(String label, String kind, String signature, String detail, String owner,
        String uri, Span span, boolean current, String origin) {
        return object("label",label,"kind",kind,"signature",signature,"detail",detail,"path",owner,"origin",origin,
            "current",current,"uri",span == null ? null : uri,"start",span == null ? null : span.start,
            "end",span == null ? null : span.end);
    }

    private Span span(CompilationUnitTree unit, Tree tree) {
        long start = positions.getStartPosition(unit,tree), end = positions.getEndPosition(unit,tree);
        return start >= 0 && end > start && end <= Integer.MAX_VALUE ? new Span((int)start,(int)end) : null;
    }

    private Span namedSelection(TreePath path, String name) {
        CompilationUnitTree unit = path.getCompilationUnit();
        Tree leaf = path.getLeaf();
        SignatureInspector.Source source = sources.get(unit.getSourceFile().toUri().toString());
        Span bounds = span(unit,leaf);
        if (source == null || bounds == null || bounds.end > source.text.length() || name.isEmpty()) return null;
        int from = bounds.start, to = Math.min(bounds.end,from + 16384);
        if (leaf instanceof MethodTree method && method.getReturnType() != null) {
            Span type = span(unit,method.getReturnType());
            Span body = method.getBody() == null ? null : span(unit,method.getBody());
            if (type != null) from = type.end;
            if (body != null) to = Math.min(to,body.start);
            if (!method.getParameters().isEmpty()) {
                Span first = span(unit,method.getParameters().get(0));
                if (first != null) to = Math.min(to,first.start);
            }
        } else if (leaf instanceof VariableTree field && field.getType() != null) {
            Span type = span(unit,field.getType());
            Span initializer = field.getInitializer() == null ? null : span(unit,field.getInitializer());
            if (type != null) from = type.end;
            if (initializer != null) to = Math.min(to,initializer.start);
            if (path.getParentPath().getLeaf() instanceof ClassTree enclosing) {
                for (Tree sibling : enclosing.getMembers()) {
                    if (sibling == field) break;
                    Span earlier = span(unit,sibling);
                    if (earlier != null && earlier.end < to) from = Math.max(from,earlier.end);
                }
            }
        } else if (leaf instanceof ClassTree declaration) {
            for (Tree member : declaration.getMembers()) {
                Span first = span(unit,member);
                if (first != null && first.start > from) to = Math.min(to,first.start);
            }
        } else return null;
        if (from >= to) return null;
        var matcher = TOKENS.matcher(source.text).region(from,to);
        List<Token> tokens = new ArrayList<>();
        while (matcher.find()) {
            String token = matcher.group();
            if (!Character.isWhitespace(token.charAt(0)) && !token.startsWith("//") && !token.startsWith("/*"))
                tokens.add(new Token(token,new Span(matcher.start(),matcher.end())));
        }
        for (int index = 0; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (!token.text.equals(name)) continue;
            String previous = index > 0 ? tokens.get(index - 1).text : "";
            String next = index + 1 < tokens.size() ? tokens.get(index + 1).text : "";
            if (leaf instanceof ClassTree && TYPE_KEYWORDS.contains(previous) ||
                leaf instanceof MethodTree && next.equals("(") ||
                leaf instanceof VariableTree && Set.of("=",",",";","[").contains(next)) return token.span;
        }
        return null;
    }
}
