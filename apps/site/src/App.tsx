import { Bento } from "./components/Bento";
import { BuiltOn } from "./components/BuiltOn";
import { Cta } from "./components/Cta";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { HowItWorks } from "./components/HowItWorks";
import { Nav } from "./components/Nav";
import { Proof } from "./components/Proof";
import { Split } from "./components/Split";
import { UseCases } from "./components/UseCases";

export function App() {
  return (
    <>
      <a
        href="#main"
        className="absolute -top-15 left-3 z-100 rounded-lg bg-charcoal px-4 py-2.5 font-bold text-white no-underline focus:top-3"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <BuiltOn />
        <Split />
        <Bento />
        <HowItWorks />
        <Proof />
        <UseCases />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
